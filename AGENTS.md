# Local build delivery

- After changing extension source, finish the applicable checks and run `npm run build` (or `npm run package`, which also builds).
- Always update the unpacked extension in `/Users/ye/code/BiliBiliSubtitle/dist/bili-whole-subtitles` (`dist/bili-whole-subtitles` relative to this repository). This is the user's fixed Chrome extension directory.
- Keep that directory stable; do not deliver only a versioned ZIP or require the user to extract into and load a new directory each time.
- `npm run package` additionally produces `dist/bili-whole-subtitles.zip` and its checksum for distribution. ZIP entries must remain at the extension root for the existing release workflow.
- Explain updates as refreshing the existing extension and video page, not reinstalling or selecting a new directory. A page refresh alone does not reload a changed Chrome extension service worker or manifest.
