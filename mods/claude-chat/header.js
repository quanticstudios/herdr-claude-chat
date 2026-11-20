// The chat's header strip: Claude mark, title, branch, status and the terminal, panel and more buttons.
import { div, svg, image } from "gpui-kit";
import { Popup, v_flex, h_flex } from "gpui-base";
import { run, layout, notify } from "herdr";

const ICON = (name) => `mods/claude-chat/icons/${name}.svg`;
const STATUS = { working: "Working", blocked: "Needs you", done: "Done" };
const stop = (_e, cx) => cx.stop_propagation();

function find(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) { const f = find(c, id); if (f) return f; }
  return null;
}

/** The Changes side panel's open state and a toggle for it, from the shown layout. */
function changesPanel() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  const open = !!panel && !panel.hidden && body?.active === "changes";
  return {
    exists: !!panel,
    open,
    toggle: () => {
      if (open) run("layout.hide", { id: "panel" });
      else { run("layout.select", { stack: "panel-body", child: "changes" }); run("layout.show", { id: "panel" }); }
    },
  };
}

function ghost(t, id, { icon, label, tip, on, act }) {
  return h_flex().id(id).h(28).min_w(28).px(label ? 10 : 0).gap(6).flex_none().items_center().justify_center()
    .rounded(t.radius.chip).text_size(t.size.small).font_weight(500)
    .bg(on ? t.c.selected : "#00000000").text_color(on ? t.c.foreground : t.c.muted)
    .hover((s) => s.bg(t.c.hover).text_color(t.c.foreground)).cursor_pointer()
    .when(Boolean(tip), (el) => el.tooltip(tip))
    .on_mouse_down("left", stop)
    .when(Boolean(act), (el) => el.on_click((_e, cx) => { cx.stop_propagation(); act(cx); }))
    .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(14).flex_none()))
    .when(Boolean(label), (el) => el.child(label));
}

function statusPill(t, status) {
  const word = STATUS[status];
  if (!word) return null;
  const color = t.c[status] ?? t.c.muted;
  const dot = div().size(6).rounded(3).bg(color).flex_none();
  return h_flex().flex_none().gap(6).items_center().text_size(t.size.small).text_color(status === "blocked" ? color : t.c.muted)
    .child(status === "working" ? dot.loop("opacity", { from: 0.35, to: 1, period: 1200 }) : dot)
    .child(word);
}

function menuItem(t, id, label, hint, act) {
  return h_flex().id(id).h(28).px(10).gap(12).items_center().justify_between().rounded(t.radius.chip)
    .text_size(t.size.ui).text_color(t.c.foreground).hover((s) => s.bg(t.c.hover)).cursor_pointer()
    .on_click((_e, cx) => { cx.stop_propagation(); act(cx); })
    .child(label).when(Boolean(hint), (el) => el.child(div().text_size(t.size.small).text_color(t.c.muted).child(hint)));
}

/** Renders the header for a Chat; `ui` holds the more menu's open state across renders. */
export function header(chat, ctx, ui = {}) {
  const t = ctx.t;
  const panel = changesPanel();
  const close = (cx) => { ui.more = false; cx.notify(); };
  const menu = v_flex().w(240).p(4).gap(2).rounded(t.radius.block).bg(t.c.popover).border_1().border_color(t.c.border).shadow_md()
    .child(menuItem(t, "m-term", "Terminal view", "Alt+T", (cx) => { close(cx); chat.toggle(cx); }))
    .when(panel.exists, (el) => el.child(menuItem(t, "m-files", "Show files", null, (cx) => {
      close(cx); run("layout.select", { stack: "panel-body", child: "files" }); run("layout.show", { id: "panel" });
    })))
    .when(Boolean(chat.cwd), (el) => el.child(menuItem(t, "m-copy", "Copy folder path", null, (cx) => {
      close(cx); ctx.copy(chat.cwd); notify({ title: "Copied", body: chat.cwd, level: "success", timeout: 2000 });
    })))
    .when(Boolean(chat.pane), (el) => el.child(menuItem(t, "m-close", "Close chat, keep terminal", null, (cx) => { close(cx); chat.detach(); })));
  const trigger = ghost(t, "h-more", { icon: "ellipsis", tip: "More", on: ui.more, act: (cx) => {
    // why: the press that opened the trigger also lands as a press outside the open menu; that one already closed it.
    if (Date.now() - (ui.closedAt ?? 0) > 250) ui.more = !ui.more;
    cx.notify();
  } });
  const more = Popup.new("chat-more", trigger).anchor("top_right")
    .when(Boolean(ui.more), (el) => el.content(menu.on_mouse_down_out((_e, cx) => { ui.more = false; ui.closedAt = Date.now(); cx.notify(); })));
  return h_flex().h(44).flex_none().px(16).gap(8).items_center().border_b_1().border_color(t.c.border).bg(t.c.background)
    .child(image(ICON("claude")).size(16).flex_none())
    .child(div().min_w(0).flex_shrink_1().truncate().text_size(t.size.body).font_weight(600).text_color(t.c.foreground).child(chat.title))
    .when(Boolean(chat.branch), (el) => el.child(h_flex().min_w(0).flex_shrink_1().gap(4).items_center().text_size(t.size.small).text_color(t.c.muted)
      .child(svg(ICON("git-branch")).size(12).flex_none()).child(div().truncate().child(chat.branch))))
    .when(Boolean(statusPill(t, chat.status)), (el) => el.child(statusPill(t, chat.status)))
    .child(div().flex_1())
    .child(ghost(t, "h-term", { icon: "terminal", label: "Terminal", tip: "Claude's terminal (Alt+T)", act: (cx) => chat.toggle(cx) }))
    .when(panel.exists, (el) => el.child(ghost(t, "h-changes", { icon: "changes", tip: "Changes", on: panel.open, act: panel.toggle })))
    .child(more);
}

/** The thin strip over the live TUI in the terminal view. */
export function terminalBar(chat, ctx) {
  const t = ctx.t;
  return h_flex().size_full().px(16).gap(8).items_center().bg(t.c.surface)
    .child(svg(ICON("terminal")).size(14).flex_none().text_color(t.c.muted))
    .child(div().min_w(0).flex_shrink_1().truncate().text_size(t.size.ui).font_weight(600).text_color(t.c.foreground).child(chat.title))
    .child(div().flex_none().text_size(t.size.small).text_color(t.c.muted).child("terminal view · claude"))
    .when(Boolean(statusPill(t, chat.status)), (el) => el.child(statusPill(t, chat.status)))
    .child(div().flex_1())
    .child(h_flex().id("t-back").h(28).px(10).gap(8).flex_none().items_center().rounded(t.radius.chip)
      .bg(t.c.raised).text_size(t.size.small).font_weight(500).text_color(t.c.foreground)
      .hover((s) => s.bg(t.c.hover)).cursor_pointer().tooltip("Back to chat (Alt+T)")
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); chat.toggle(cx); })
      .child("Back to chat").child(div().text_color(t.c.muted).child("Alt+T")));
}
