import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import QUESTIONS from './questions';

const STORAGE_KEY = 'infosec-quiz-state-v1';
const IS_WEB = Platform.OS === 'web';
const INTERVALS = [
  { label: 'Off', minutes: 0 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '3 hours', minutes: 180 },
  { label: '6 hours', minutes: 360 },
];
const QUIET_START = 22; // no reminders from 22:00 …
const QUIET_END = 8; // … until 08:00
const MAX_SCHEDULED = 40; // iOS caps pending local notifications at 64

const byId = Object.fromEntries(QUESTIONS.map((q) => [q.id, q]));
const LESSONS = [...new Set(QUESTIONS.map((q) => q.lesson))].sort((a, b) => a - b);

const DEFAULT_STATE = {
  intervalMinutes: 60,
  lessons: [], // empty = all lessons
  history: {}, // id -> { right, wrong }
  answered: 0,
  correct: 0,
  streak: 0,
  bestStreak: 0,
};

if (!IS_WEB) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

// Prefer questions never seen, then ones answered wrong, and avoid repeating the current one.
function pickQuestion(state, excludeId) {
  const pool = QUESTIONS.filter(
    (q) => (state.lessons.length === 0 || state.lessons.includes(q.lesson)) && q.id !== excludeId,
  );
  if (pool.length === 0) return byId[excludeId] ?? QUESTIONS[0];
  const weighted = pool.map((q) => {
    const h = state.history[q.id];
    const weight = !h ? 4 : 1 + 2 * h.wrong - 0.5 * Math.min(h.right, 1);
    return { q, weight: Math.max(weight, 0.25) };
  });
  let r = Math.random() * weighted.reduce((s, w) => s + w.weight, 0);
  for (const w of weighted) {
    r -= w.weight;
    if (r <= 0) return w.q;
  }
  return weighted[weighted.length - 1].q;
}

function inQuietHours(date) {
  const h = date.getHours();
  return QUIET_START > QUIET_END ? h >= QUIET_START || h < QUIET_END : h >= QUIET_START && h < QUIET_END;
}

function nextReminderTimes(intervalMinutes, count) {
  const times = [];
  let t = new Date(Date.now() + intervalMinutes * 60_000);
  while (times.length < count) {
    if (inQuietHours(t)) {
      const morning = new Date(t);
      if (t.getHours() >= QUIET_START) morning.setDate(morning.getDate() + 1);
      morning.setHours(QUIET_END, Math.floor(Math.random() * 20), 0, 0);
      t = morning;
    }
    times.push(t);
    t = new Date(t.getTime() + intervalMinutes * 60_000);
  }
  return times;
}

async function scheduleReminders(state) {
  if (IS_WEB) return 'unsupported';
  await Notifications.cancelAllScheduledNotificationsAsync();
  if (!state.intervalMinutes) return 'off';

  let { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
  if (status !== 'granted') return 'denied';

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('questions', {
      name: 'Quiz questions',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
  }

  const times = nextReminderTimes(state.intervalMinutes, MAX_SCHEDULED);
  let lastId;
  for (const date of times) {
    const q = pickQuestion(state, lastId);
    lastId = q.id;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `🔐 Lesson ${String(q.lesson).padStart(2, '0')} question`,
        body: q.q,
        data: { questionId: q.id },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date, channelId: 'questions' },
    });
  }
  return 'scheduled';
}

function QuizScreen() {
  const [state, setState] = useState(null);
  const [current, setCurrent] = useState(null);
  const [selected, setSelected] = useState(null);
  const [reminderStatus, setReminderStatus] = useState(IS_WEB ? 'unsupported' : 'off');
  const [showSettings, setShowSettings] = useState(false);
  const lastResponse = IS_WEB ? undefined : Notifications.useLastNotificationResponse();
  const handledResponse = useRef(null);
  const scrollRef = useRef(null);

  // Load saved progress & settings.
  useEffect(() => {
    (async () => {
      let saved = {};
      try {
        saved = JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? '{}');
      } catch {}
      const s = { ...DEFAULT_STATE, ...saved };
      setState(s);
      setCurrent((c) => c ?? pickQuestion(s));
      setReminderStatus(await scheduleReminders(s).catch(() => 'error'));
    })();
  }, []);

  // Persist on change.
  useEffect(() => {
    if (state) AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {});
  }, [state]);

  // Opening the app from a notification shows that notification's question.
  useEffect(() => {
    if (!lastResponse) return;
    const id = lastResponse.notification.request.identifier;
    if (handledResponse.current === id) return;
    handledResponse.current = id;
    const q = byId[lastResponse.notification.request.content.data?.questionId];
    if (q) {
      setCurrent(q);
      setSelected(null);
    }
  }, [lastResponse]);

  const answer = useCallback(
    (index) => {
      if (selected !== null || !current) return;
      setSelected(index);
      const right = index === current.answer;
      setState((s) => {
        const h = s.history[current.id] ?? { right: 0, wrong: 0 };
        const streak = right ? s.streak + 1 : 0;
        return {
          ...s,
          answered: s.answered + 1,
          correct: s.correct + (right ? 1 : 0),
          streak,
          bestStreak: Math.max(s.bestStreak, streak),
          history: { ...s.history, [current.id]: { right: h.right + (right ? 1 : 0), wrong: h.wrong + (right ? 0 : 1) } },
        };
      });
    },
    [current, selected],
  );

  const next = useCallback(() => {
    setCurrent(pickQuestion(state, current?.id));
    setSelected(null);
    scrollRef.current?.scrollTo({ y: 0, animated: true });
  }, [state, current]);

  const updateSettings = useCallback(
    (patch) => {
      const updated = { ...state, ...patch };
      setState(updated);
      scheduleReminders(updated)
        .then(setReminderStatus)
        .catch(() => setReminderStatus('error'));
    },
    [state],
  );

  const toggleLesson = (lesson) => {
    const set = new Set(state.lessons);
    set.has(lesson) ? set.delete(lesson) : set.add(lesson);
    const lessons = [...set].sort((a, b) => a - b);
    updateSettings({ lessons: lessons.length === LESSONS.length ? [] : lessons });
  };

  // Shuffle option order each time a question is shown.
  const order = useMemo(() => {
    const o = [0, 1, 2, 3];
    for (let i = o.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [o[i], o[j]] = [o[j], o[i]];
    }
    return o;
  }, [current]);

  const accuracy = useMemo(
    () => (state?.answered ? Math.round((100 * state.correct) / state.answered) : 0),
    [state],
  );

  if (!state || !current) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  const reminderText = {
    unsupported: 'Reminders work in the phone app (not in the web preview).',
    off: 'Reminders are off.',
    denied: 'Notifications are blocked. Allow them in your phone settings.',
    error: 'Could not schedule reminders.',
    scheduled: `A new question every ${INTERVALS.find((i) => i.minutes === state.intervalMinutes)?.label}, except ${QUIET_START}:00–${String(QUIET_END).padStart(2, '0')}:00.`,
  }[reminderStatus];

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>InfoSec Quiz</Text>
          <Text style={styles.muted}>{QUESTIONS.length} questions · 12 lessons</Text>
        </View>
        <Pressable
          onPress={() => setShowSettings((v) => !v)}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Settings"
        >
          <Text style={styles.iconButtonText}>{showSettings ? 'Done' : 'Settings'}</Text>
        </Pressable>
      </View>

      <ScrollView ref={scrollRef} contentContainerStyle={styles.content}>
        <View style={styles.statsRow}>
          <Stat label="Answered" value={state.answered} />
          <Stat label="Accuracy" value={`${accuracy}%`} />
          <Stat label="Streak" value={state.streak} />
          <Stat label="Best" value={state.bestStreak} />
        </View>

        {showSettings ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Ask me a question every…</Text>
            <View style={styles.chips}>
              {INTERVALS.map((i) => (
                <Chip
                  key={i.minutes}
                  label={i.label}
                  active={state.intervalMinutes === i.minutes}
                  disabled={IS_WEB}
                  onPress={() => updateSettings({ intervalMinutes: i.minutes })}
                />
              ))}
            </View>
            <Text style={[styles.muted, styles.note]}>{reminderText}</Text>

            <Text style={[styles.sectionTitle, { marginTop: 20 }]}>Lessons</Text>
            <View style={styles.chips}>
              <Chip label="All" active={state.lessons.length === 0} onPress={() => updateSettings({ lessons: [] })} />
              {LESSONS.map((l) => (
                <Chip key={l} label={`L${String(l).padStart(2, '0')}`} active={state.lessons.includes(l)} onPress={() => toggleLesson(l)} />
              ))}
            </View>

            <Pressable
              onPress={() => updateSettings({ history: {}, answered: 0, correct: 0, streak: 0, bestStreak: 0 })}
              style={({ pressed }) => [styles.resetButton, pressed && styles.pressed]}
            >
              <Text style={styles.resetText}>Reset progress</Text>
            </Pressable>
          </View>
        ) : (
          <>
            <View style={styles.card}>
              <Text style={styles.lessonTag}>LESSON {String(current.lesson).padStart(2, '0')}</Text>
              <Text style={styles.question}>{current.q}</Text>

              {order.map((i, pos) => {
                const opt = current.options[i];
                const isAnswer = i === current.answer;
                const isPicked = i === selected;
                const revealed = selected !== null;
                return (
                  <Pressable
                    key={i}
                    disabled={revealed}
                    onPress={() => answer(i)}
                    style={({ pressed }) => [
                      styles.option,
                      pressed && styles.pressed,
                      revealed && isAnswer && styles.optionRight,
                      revealed && isPicked && !isAnswer && styles.optionWrong,
                      revealed && !isAnswer && !isPicked && styles.optionDim,
                    ]}
                    accessibilityRole="button"
                  >
                    <Text style={styles.optionLetter}>{'ABCD'[pos]}</Text>
                    <Text style={styles.optionText}>{opt}</Text>
                    {revealed && isAnswer && <Text style={styles.mark}>✓</Text>}
                    {revealed && isPicked && !isAnswer && <Text style={styles.mark}>✗</Text>}
                  </Pressable>
                );
              })}

              {selected !== null && (
                <View style={[styles.feedback, selected === current.answer ? styles.feedbackRight : styles.feedbackWrong]}>
                  <Text style={styles.feedbackTitle}>{selected === current.answer ? 'Correct!' : 'Not quite.'}</Text>
                  <Text style={styles.feedbackText}>{current.explain}</Text>
                </View>
              )}
            </View>

            <Pressable onPress={next} style={({ pressed }) => [styles.nextButton, pressed && styles.pressed]} accessibilityRole="button">
              <Text style={styles.nextText}>{selected === null ? 'Skip' : 'Next question'} →</Text>
            </Pressable>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function Stat({ label, value }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Chip({ label, active, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [styles.chip, active && styles.chipActive, pressed && styles.pressed, disabled && { opacity: 0.4 }]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <QuizScreen />
    </SafeAreaProvider>
  );
}

const C = {
  bg: '#F3F5F9',
  card: '#FFFFFF',
  text: '#141B2D',
  muted: '#667085',
  border: '#E3E7EF',
  primary: '#2F5BEA',
  right: '#E6F6EC',
  rightBorder: '#2E9E5B',
  wrong: '#FDECEC',
  wrongBorder: '#D64545',
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  title: { fontSize: 26, fontWeight: '800', color: C.text },
  muted: { color: C.muted, fontSize: 13 },
  iconButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, backgroundColor: C.card, borderWidth: 1, borderColor: C.border },
  iconButtonText: { color: C.primary, fontWeight: '600' },
  content: { paddingHorizontal: 16, paddingBottom: 40, maxWidth: 640, width: '100%', alignSelf: 'center' },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  stat: { flex: 1, backgroundColor: C.card, borderRadius: 12, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: C.border },
  statValue: { fontSize: 18, fontWeight: '700', color: C.text, fontVariant: ['tabular-nums'] },
  statLabel: { fontSize: 11, color: C.muted, marginTop: 2 },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 18, borderWidth: 1, borderColor: C.border },
  lessonTag: { color: C.primary, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginBottom: 8 },
  question: { fontSize: 19, fontWeight: '600', color: C.text, lineHeight: 26, marginBottom: 16 },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: C.border,
    marginBottom: 10,
    backgroundColor: C.card,
  },
  optionRight: { backgroundColor: C.right, borderColor: C.rightBorder },
  optionWrong: { backgroundColor: C.wrong, borderColor: C.wrongBorder },
  optionDim: { opacity: 0.55 },
  optionLetter: { fontWeight: '700', color: C.muted, width: 16 },
  optionText: { flex: 1, fontSize: 15, color: C.text, lineHeight: 21 },
  mark: { fontSize: 18, fontWeight: '800', color: C.text },
  feedback: { marginTop: 6, padding: 14, borderRadius: 12, borderLeftWidth: 4 },
  feedbackRight: { backgroundColor: C.right, borderLeftColor: C.rightBorder },
  feedbackWrong: { backgroundColor: C.wrong, borderLeftColor: C.wrongBorder },
  feedbackTitle: { fontWeight: '700', marginBottom: 4, color: C.text },
  feedbackText: { color: C.text, lineHeight: 20 },
  nextButton: { marginTop: 14, backgroundColor: C.primary, borderRadius: 14, paddingVertical: 16, alignItems: 'center' },
  nextText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  pressed: { opacity: 0.7 },
  sectionTitle: { fontWeight: '700', fontSize: 15, color: C.text, marginBottom: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: C.border, backgroundColor: C.bg },
  chipActive: { backgroundColor: C.primary, borderColor: C.primary },
  chipText: { color: C.text, fontWeight: '600', fontSize: 13 },
  chipTextActive: { color: '#fff' },
  note: { marginTop: 10, lineHeight: 18 },
  resetButton: { marginTop: 24, alignSelf: 'flex-start', paddingVertical: 8 },
  resetText: { color: C.wrongBorder, fontWeight: '600' },
});
