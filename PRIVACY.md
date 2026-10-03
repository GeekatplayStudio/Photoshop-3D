# Privacy Policy - Geekatplay 3D Layers

Geekatplay Studio - Vladimir Chopine - https://www.geekatplay.com

Last updated: October 3, 2026

Geekatplay 3D Layers (the Photoshop plugin) does not collect, store or send any personal data
to Geekatplay Studio. There are no Geekatplay accounts.

## What the plugin sends, and where

The plugin talks only to the 3D services you set up, and only when you use them:

- **When you click Generate:** the pixels of the layer or selection you chose go to the one
  service you picked: Meshy (meshy.ai), Tripo (tripo3d.ai), Hitem3D (hi3d.ai) or your
  ComfyUI server. The settings for that service go with them (model, quality, and so on).
- **Your API key** for that service is sent with each of its requests, as the service
  requires. Keys are never sent anywhere else.
- **When you open Browse or a job finishes:** the plugin asks that service for your list of
  models and downloads the models and previews you import.
- **Test connection** asks the service for your account balance.
- **Update check (GitHub copies only):** the copy installed from the project's GitHub page
  asks GitHub (api.github.com) for the latest release, at most every 12 hours. You can turn
  this off in Settings › Updates. A copy installed from the Creative Cloud Marketplace never
  does this; Creative Cloud updates it.

Each service handles what you send under its own privacy policy:

- Meshy: https://www.meshy.ai/privacy-policy
- Tripo: https://www.tripo3d.ai/privacy
- Hitem3D: https://docs.hitem3d.ai/en/api/resources/privacy-policy

A ComfyUI server is your own (or one you choose); its address is yours to set.

## What is stored

On your computer, in your user folder (`%APPDATA%\Geekatplay\3D Layers` on Windows,
`~/Library/Application Support/Geekatplay/3D Layers` on macOS):

- the model library: the models, their previews, and the image each generated model was made from;
- your settings (`settings.json`) and API keys (`credentials.json`, readable only by your user);
- recent jobs and a log of what the plugin did. The log never contains API keys.

Inside your documents: each 3D layer stores its model name, pose and lighting in the layer's
metadata, so it can be edited again.

Nothing of this leaves your computer unless you send it.

## No tracking

No analytics, telemetry, crash reports, advertising identifiers, cookies or accounts.

## Links

Links in the plugin (the guide, a service's key page, release notes) open in your browser only
when you click them. The website's own privacy policy applies there.

## Contact

Questions about this policy: open an issue at
https://github.com/GeekatplayStudio/Photoshop-3D/issues or use the contact page at
https://www.geekatplay.com.
