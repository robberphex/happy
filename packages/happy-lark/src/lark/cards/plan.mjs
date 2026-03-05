import { escapeLarkMd } from "./common.mjs"

const STATUS_STYLES = {
  completed: {
    iconToken: "todo_outlined",
    iconColor: "light_grey",
    formatContent: (escaped) => `<font color=grey>~~${escaped}~~</font>`,
  },
  in_progress: {
    iconToken: "replace_outlined",
    iconColor: "grey",
    formatContent: (escaped) => escaped,
  },
  pending: {
    iconToken: "w1-h1_outlined",
    iconColor: "black",
    formatContent: (escaped) => escaped,
  },
}

const PRIORITY_ICONS = {
  high: "up-top_outlined",
  medium: "up_outlined",
}

function buildPlanEntryElement(entry) {
  const style = STATUS_STYLES[entry.status] ?? STATUS_STYLES.pending
  const escaped = escapeLarkMd(entry.content)
  const content = style.formatContent(escaped)

  const markdownElement = {
    tag: "markdown",
    content,
    icon: {
      tag: "standard_icon",
      token: style.iconToken,
      color: style.iconColor,
    },
  }

  const priorityToken = PRIORITY_ICONS[entry.priority]
  if (!priorityToken) {
    return markdownElement
  }

  return {
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "8px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [markdownElement],
      },
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [
          {
            tag: "div",
            text: { tag: "lark_md", content: "" },
            icon: { tag: "standard_icon", token: priorityToken },
          },
        ],
      },
    ],
  }
}

export function buildPlanCard(entries) {
  return {
    schema: "2.0",
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    body: {
      vertical_spacing: "4px",
      elements: entries.map((entry) => buildPlanEntryElement(entry)),
    },
  }
}
