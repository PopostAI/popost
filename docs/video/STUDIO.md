# Local Video Studio

Open an existing project with `popost video preview <project> --edit` and optionally
`--reference <video>`. Keep the preview process running while using its local URL.
The same preview command continues to support the original read-only interface.

The editor uses the existing project model: sequential shots, HTML scenes, overlay
tracks, captions and audio. Shot navigation, grouped timeline lanes, property forms,
reference comparison, audio audition and waveform previews share that model. Scene
fields expose declared `data-slot` text and image values; changing a slot overrides
that shot without rewriting its scene file. Arbitrary HTML internals are not separate
editable objects. Voice generation remains an Agent operation.

The Code tab, below Elements, edits the project's `video.json`. Valid changes save
automatically after a short pause and participate in undo and redo. Invalid input stays
in the editor without replacing the saved draft. Concurrent source edits are rejected
until the user reloads the JSON. Download JSON exports the text currently in the tab.
Local versions snapshot JSON and continue to reference the original assets; they are
not complete project archives. Timepoint comments stay in the local project.

Export settings include filename, SDR, resolution, frame rate, bitrate, audio and a
frame range. HDR is shown as unavailable because the renderer produces SDR. Export
captures the JSON at the start; assets continue to resolve from the project directory.
Outputs and export receipts are kept under `.studio/`. The result can be played and
downloaded, including after reopening the editor. The service validates ranges and
paid resolutions as well as the browser controls. A verified paid account is required
for 2K and 4K; the unlock link opens the public pricing page. No credentials are sent
to the browser. Lower resolutions and ordinary local editing work without an account.
