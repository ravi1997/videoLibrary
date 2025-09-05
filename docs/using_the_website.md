# Using the Website

This guide describes a typical user journey through the web interface powered by this backend.

## 1. Registration & Onboarding
1. New user submits registration (or employee lookup if corporate context).
2. Receives OTP (mobile) and verifies.
3. Finalizes account with username, email, password, and (optionally) uploads ID document.
4. Awaits admin verification if required for elevated access.

## 2. Logging In
- Users log in with email/username/employee_id + password OR mobile + OTP.
- Upon success a JWT is stored (header and/or secure cookie) and the UI gains access to protected routes.

## 3. Uploading a Video (Uploader/Admin)
1. Navigate to Upload page.
2. Select supported file (.mp4/.mov/.mkv/.avi ≤ 500 MB).
3. After upload returns UUID, provide metadata (title, description, category, tags, surgeons) through metadata form.
4. Page polls or refreshes to see `processed` status once transcoding finishes.

## 4. Browsing & Discovery
- Home/Explore lists videos with sorting (recent, trending, most viewed).
- Filters: category dropdown, tags, surgeon list.
- Search bar performs full-field search (title, description, transcript, tags, category, surgeon).

## 5. Watching Videos
- Player requests master playlist via `/video/hls/<uuid>/master.m3u8`.
- As playback progresses, JS periodically posts progress updates so user can resume later.
- Related videos appear using recommendations/watch-next endpoints.

## 6. Favorites & History
- Click favorite icon toggles status via POST/DELETE endpoints.
- History page shows viewing progress percentage and sorting controls.
- User can remove a single item or clear all history.

## 7. Account Settings
- Adjust theme (system/light/dark), playback defaults (autoplay, quality, speed), privacy toggles.
- Changes persist via settings API and rehydrate on login.

## 8. Admin Dashboard (Admin/Superadmin)
- Review unverified users; inspect documents; verify or discard accounts.
- Manage user roles (future enhancement) and unlock locked accounts.

## 9. Password & Security Maintenance
- Users rotate passwords using change password form.
- Forgotten passwords: initiate reset, receive token (SMS), complete with new password.

## 10. Logging Out
- Session invalidated; token added to blocklist. Re-authentication required for further access.

## UX Enhancement Ideas
- Add WebSocket notifications for transcode completion.
- Display resolution selector & bandwidth estimation.
- Provide thumbnail hover previews (sprite sheets).
- Add continue-watching shelf on homepage.

## Accessibility Considerations
- Ensure semantic HTML in templates.
- Provide subtitles/closed captions from `transcript` field where available.
- Maintain color contrast for dark/light themes.
