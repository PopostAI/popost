# Export to a desktop video editor

In local Studio, choose **Export → Draft → Jianying Pro / CapCut → Export**. Studio writes a complete draft directly into the selected application's local drafts folder. There is no ZIP download or manual installation step.

After the files are saved, a success dialog shows the exported draft name and **Later** plus **Restart application** (or **Open application** when it was not running). Later closes the notice without changing the running application. Restart stops only that application's main process, waits for it to exit, and launches the detected installation. If quitting does not finish, the draft stays saved and the dialog offers a retry; there is no force termination. Do not equate a launch acknowledgement with proof that a native timeline opened.

The local host detects installed applications and their configured draft location. Unavailable custom locations are errors, not permission to create a replacement directory on another disk. Each export has its own folder and id, so existing drafts are preserved. A repeated request for the same export id and snapshot returns the existing result. A changed timeline needs a new export.

The draft contains its own copies of all media, absolute paths to those copies, matching content/info files, metadata, a cover and auxiliary folders. The desktop editor refreshes its own draft index when it opens; Studio does not overwrite the application's index while it is running. The original Popost project can be moved without breaking those imported media copies.

Video segments, audio segments, caption text and caption timing remain editable. Complex visuals are rendered per segment. Caption styling must be reapplied in the target editor. Scene source and linked local resources participate in the render cache key, so a revised scene exports its revised appearance.

This flow requires Studio to run on the Mac or Windows computer that holds the target application and its drafts. A remote web sandbox cannot directly modify a different computer's draft library. If an installation cannot be located but its existing drafts folder is available, Studio can save there and tells the user to open the application manually.
