/** JSON + CSV export, and JSON restore. */
import { toast } from "./dom.js";
import { state, replaceState } from "./state.js";

function csvEscape(x){
  const s = String(x ?? "");
  if(s.includes(",") || s.includes('"') || s.includes("\n")){
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

function downloadFile(filename, contents, mime){
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function exportData(){
  downloadFile(`90dwp-backup-${Date.now()}.json`, JSON.stringify(state, null, 2), "application/json");

  const rows = [["date","outcome1","done1","outcome2","done2","outcome3","done3","imUp","babyUp","napStart","napEnd"]];
  Object.keys(state.days).sort().forEach(k => {
    const d = state.days[k];
    const iso = (ts) => ts ? new Date(ts).toISOString() : "";
    rows.push([
      k,
      d.outcomes?.[0] || "", d.outcomesDone?.[0] ? "1" : "0",
      d.outcomes?.[1] || "", d.outcomesDone?.[1] ? "1" : "0",
      d.outcomes?.[2] || "", d.outcomesDone?.[2] ? "1" : "0",
      iso(d.events?.imUp), iso(d.events?.babyUp), iso(d.events?.napStart), iso(d.events?.napEnd)
    ]);
  });
  downloadFile(`90dwp-export-${Date.now()}.csv`, rows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");

  // The JSON backup already carries reminders; this is the readable copy, for
  // the same reason the day log gets one.
  const lists = new Map((state.reminders?.lists || []).map(l => [l.id, l.name]));
  const remRows = [["list", "title", "due", "hasTime", "repeat", "priority", "flagged", "tags", "completed", "completedAt", "notes"]];
  for(const item of state.reminders?.items || []){
    remRows.push([
      lists.get(item.listId) || "",
      item.title,
      item.dueAt ? new Date(item.dueAt).toISOString() : "",
      item.hasTime ? "1" : "0",
      item.repeat ? `${item.repeat.freq}/${item.repeat.interval}` : "",
      item.priority,
      item.flagged ? "1" : "0",
      (item.tags || []).join(" "),
      item.completed ? "1" : "0",
      item.completedAt ? new Date(item.completedAt).toISOString() : "",
      item.notes
    ]);
  }
  if(remRows.length > 1){
    downloadFile(`90dwp-reminders-${Date.now()}.csv`, remRows.map(r => r.map(csvEscape).join(",")).join("\n"), "text/csv");
  }

  toast("Exported.");
}

/**
 * The file dialog resolves long after the click handler returns, so the caller
 * passes onDone to re-render once the import has actually landed.
 */
export function importData(onDone){
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = () => {
    const file = input.files?.[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        replaceState(JSON.parse(reader.result));
        toast("Imported ✅");
        if(typeof onDone === "function") onDone();
      } catch {
        toast("Import failed.");
      }
    };
    reader.readAsText(file);
  };
  input.click();
}
