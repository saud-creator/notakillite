# Design review artifacts

Open `index.html` in a browser for the interactive redesign proposal. It is a standalone local file with no libraries, remote assets, account connection, or audio processing. All notes and exports in it are sample data. The production interface remains a native Windows app; HTML is used here to make the plan concrete and easy to review.

Try folder selection, search, Audio only, recording checkboxes, cleanup presets, Advanced, themes, the compact export queue, and the connection-state selector. At narrow widths the recording inspector opens as a detail pane. Export runs a labeled simulation and never writes lecture files.

Run `node scripts/brave/design-preview-check.mjs` to exercise the prototype in installed Brave with an isolated test browser and produce screenshots plus a verification report in `design/review/`. The check does not access a real browser profile or account. Passing it verifies this prototype only; native implementation and real-account testing are separate release gates in `PRODUCT-REDESIGN-PLAN.md`.
