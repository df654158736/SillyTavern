# Current Scene Image

Model-agnostic SillyTavern UI extension for the current-scene image flow and native image-generation handoff.

It lets the user trim one chat message, generates an image prompt through a dedicated Connection Manager profile, shows the exact prompt for review, and then passes the approved text to SillyTavern's native `/imagine` command. The prompt template is editable for Krea, Flux, SDXL, Pony, or another backend. The native Image Generation extension remains responsible for backend settings, workflows, image storage, and galleries.

The extension can take over the existing message paintbrush button. Every click starts from the message text again, so an existing generated image never silently becomes the source for the next prompt.
