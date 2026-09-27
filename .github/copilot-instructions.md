# Interviewly project instructions

- Workspace: npm monorepo with React + TypeScript + Vite in `apps/web` and Express + TypeScript + Socket.IO + Mongoose in `apps/server`.
- Run `npm run dev` at the root to start both applications; run `npm run build` and `npm run lint` to validate.
- Keep API authentication and Socket.IO authorization based on the JWT user identity. Restrict each interview and chat room to its participants; keep presence scoped to rooms and validate/rate-limit socket payloads.
- Keep recruiter-only job posting and application-stage management role-guarded. Candidates may edit only their own profile/applications; interviewers' private evaluation notes must never be returned to candidates.
- Store only password hashes, validate external input, and do not commit `.env` files, JWT secrets, or other credentials.
- Production requires SMTP configuration, interviewer signup code, HTTPS, secure MongoDB, and environment-managed JWT secrets. Verification and password-reset tokens must remain hashed, expiring, and single-use.
- WebRTC media is peer-to-peer; use HTTPS and configure TURN with short-lived server-issued credentials for production deployments. Do not imply calls are end-to-end encrypted or recorded.
- Persist notification and interview state in MongoDB. Cover invitations, reminders, cancellation/rescheduling, calendar export, and feedback with participant authorization.
- Do not execute candidate code inside the API process. Any future code runner must use a hardened isolated sandbox service. Résumé URLs are references only until secure object storage and scanning are added.
- Keep the frontend responsive and accessible, including form labels, keyboard interactions, and visible errors.
