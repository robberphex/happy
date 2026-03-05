import { format } from "date-fns"
import { buildListCard, truncate } from "./common.mjs"

function toListItems(sessions, currentSessionId, style, descriptions) {
  return sessions.map((s) => ({
    label: truncate(s.initialPrompt, 60),
    description: descriptions?.get(s.id),
    isCurrent: currentSessionId !== undefined && s.id === currentSessionId,
    icon: style.icon,
    time: format(new Date(s.updatedAt), "yyyy-MM-dd HH:mm:ss"),
    callbackValue: { action: style.action, session_id: s.id },
  }))
}

export function buildSessionListCard(data) {
  const items = toListItems(
    data.sessions,
    data.currentSessionId,
    {
      borderColor: "grey",
      icon: { token: "chat-history_outlined" },
      action: "session_select",
    },
    data.descriptions,
  )
  return buildListCard(items, { title: data.title, borderColor: "grey" })
}

export function buildSessionDeleteCard(data) {
  const items = toListItems(
    data.sessions,
    data.currentSessionId,
    {
      borderColor: "red-300",
      icon: { token: "delete-trash_outlined", color: "red" },
      action: "session_delete",
    },
    data.descriptions,
  )
  return buildListCard(items, { title: data.title, borderColor: "red-300" })
}
