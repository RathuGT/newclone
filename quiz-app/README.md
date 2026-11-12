# InfoSec Quiz

A small Expo (React Native) app that sends you Information Security questions from time to time.
The 112 multiple-choice questions come from the course notes for Lessons 01–12.

## Features
- **Reminders:** a local notification with a question every 30 min, 1 h, 3 h or 6 h. Nothing is sent between 22:00 and 08:00. Tap a notification to open that question.
- **Explanations:** after you answer, the app shows the correct option and why it is correct.
- **Repeats what you need:** questions you have not seen yet, or got wrong, come up more often. Answer options are shuffled every time.
- **Progress:** tracks answered count, accuracy and streak, saved on the device.
- **Lesson filter:** choose which lessons to study.

## Run it on your phone
1. Install **Expo Go** from the Play Store or App Store.
2. On your computer:
   ```bash
   cd quiz-app
   npm install
   npx expo start
   ```
3. Scan the QR code with Expo Go (Android) or the Camera app (iOS).

Local notifications work in Expo Go. To get a real installable APK/IPA: `npx eas-cli@latest build -p android --profile preview`.

## Edit questions
Everything is in `questions.js`. Each entry has `lesson`, `q`, four `options`, the `answer` index and an `explain` text.
