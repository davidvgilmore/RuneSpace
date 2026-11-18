// OpenCode 2.0.25 exposes the selected session and its state as Solid stores.
// The TUI owns this PTY. A shared OpenCode background service has no entrypoint here.
export function supportsReporter(context, env, output) {
  return context.app?.version === "2.0.25" && Boolean(env.HC_TERMINAL_ID) && output.isTTY === true;
}

function status(session, id, info) {
  if (session.permission.list(id)?.length) return "state=blocked:kind=permission";
  if (session.form.list(id)?.length) return "state=blocked:kind=question";
  if (session.status(id) === "running" || session.pending.list(id).some(item => item.type !== "synthetic")) {
    return "state=working";
  }
  // The local idle marker arrives with the execution event, before the updated
  // session info. Existing sessions also carry their last outcome in the info.
  const last = session.message.list(id).at(-1);
  const outcome = last?.type === "idle" ? last.outcome : info?.outcome;
  if (outcome === "failed") return "state=error";
  if (outcome === "succeeded" || outcome === "interrupted") return "state=done";
  return "state=idle";
}

export function reportFor(context) {
  const route = context.ui.router.current();
  let fields = "state=idle";
  let title;
  if (route.type === "session") {
    const session = context.data.session;
    const info = session.get(route.sessionID);
    title = info?.title;
    fields = status(session, route.sessionID, info);
  }
  fields += ":app=opencode";
  if (title) {
    // OSC 7501 title accepts base64 UTF-8. Keep the decoded display text
    // single-line as well, even if a remote session has a misleading title.
    const clean = Array.from(title.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim()).slice(0, 128).join("");
    if (clean) fields += ":title=" + Buffer.from(clean, "utf8").toString("base64");
  }
  return "\x1b]7501;" + fields + "\x1b\\";
}

export default {
  id: "runespace.herdr-status",
  async setup(context) {
    if (!supportsReporter(context, process.env, process.stdout)) return;
    const { createEffect, createRoot } = await import("solid-js");
    let previous;
    const dispose = createRoot(stop => {
      createEffect(() => {
        const report = reportFor(context);
        if (report !== previous) {
          process.stdout.write(report);
          previous = report;
        }
      });
      return stop;
    });
    return () => {
      dispose();
      if (previous) process.stdout.write("\x1b]7501;state=clear\x1b\\");
    };
  },
};
