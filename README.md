# YouTube for TitanOS

An ad-free YouTube TV experience for TitanOS smart TVs (Philips, JVC, and other Titan OS-powered brands).

Ported from [youtube-webos](https://github.com/NicholasBly/youtube-webos).

## Features

- **Ad blocking** — Removes video ads and overlay ads
- **SponsorBlock** — Skips sponsored segments, intros, outros, etc.
- **Return YouTube Dislike** — Shows dislike counts
- **Video quality control** — Force preferred resolution
- **Thumbnail quality** — Higher-res thumbnails
- **Remote control optimized** — Full D-pad/remote navigation support
- **Settings panel** — Configure features via on-screen UI

## Requirements

- Node.js 18+
- npm 9+
- A TitanOS-powered smart TV (for on-device testing) or desktop Chrome

## Development

```bash
# Install dependencies
npm install

# Start dev server (opens http://localhost:8080)
npm run dev

# Production build
npm run build
```

### Testing on TitanOS TV

1. Build the project: `npm run build`
2. Host the `dist/` folder on a web server accessible to your TV (or use GitHub Pages)
3. On your TitanOS TV, open **DevView** (from the app store)
4. Enter your server URL to load the app in the sandbox

### Testing on Desktop Browser (User-Agent Spoofing)

YouTube TV (`youtube.com/tv`) will automatically redirect desktop browsers to the desktop site (`youtube.com/?app=desktop`). To test and debug the app on a desktop browser:

1. Open your hosted app (e.g., your GitHub Pages URL or `http://localhost:8080`).
2. Open Chrome DevTools (`F12` or `Ctrl+Shift+I`).
3. Click the three vertical dots menu in the top-right of DevTools -> **More tools** -> **Network conditions**.
4. Under **User agent**, uncheck **Use browser default**.
5. Select a TV user agent (e.g., **Android TV** or **Samsung Tizen Smart TV**), or paste a custom one:
   `Mozilla/5.0 (WebOS; SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36`
6. Refresh the page. It will now load YouTube TV without redirecting.

## Project Structure

```
src/
├── index.html          # App entry point
├── index.js            # Boot: init SDK, load YouTube TV, inject hooks
├── platform.js         # TitanOS platform abstraction
├── titanos-utils.js    # Titan SDK wrapper
├── remote-keys.js      # Remote control key mappings
├── notifications.js    # Toast notification system
├── config.js           # Settings (localStorage)
├── adblock.js          # Ad blocking (fetch/XHR interception)
├── sponsorblock.js     # SponsorBlock integration
├── return-dislike.js   # Return YouTube Dislike API
├── video-quality.js    # Video quality control
├── ui.js               # Settings panel UI
└── ...
```

## License

GPL-3.0-only — see [LICENSE](./LICENSE)

## Credits

- Original [youtube-webos](https://github.com/webosbrew/youtube-webos) project by the webOS Homebrew community
- [NicholasBly's fork](https://github.com/NicholasBly/youtube-webos) for the upstream source
- [SponsorBlock API](https://sponsor.ajay.app/)
- [Return YouTube Dislike API](https://returnyoutubedislike.com/)
