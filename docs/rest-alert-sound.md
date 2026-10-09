# Rest alert sound

`frontend/app/android/app/src/main/res/raw/rest_alert.wav` is original. It's three
rising bell tones (A5, D6, A6) played twice, made from sine waves by
`scripts/make-rest-sound.py`, with no samples or outside sources. It belongs to
this project.

Android locks a notification channel's sound once the channel exists on a phone.
A new sound needs new channel ids (`rest-timer-v2`, `rest-timer-alarm-v2`) in
`RestAlerts.java` and `src/timer/restAlarm.ts`.
