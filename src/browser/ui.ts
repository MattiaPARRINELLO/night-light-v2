export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Élément manquant dans le DOM : #${id}`);
  return node as T;
}

export type ScreenName = "drop" | "analysis" | "error" | "show";

export function showScreen(name: ScreenName): void {
  const screens: ScreenName[] = ["drop", "analysis", "error", "show"];
  for (const screen of screens) {
    const node = el<HTMLElement>(`screen-${screen}`);
    const active = screen === name;
    node.hidden = !active;
    node.classList.toggle("is-active", active);
  }
}

export function setStatus(message: string): void {
  const live = el<HTMLElement>("live");
  live.textContent = message;
}

export function setUploadState(state: {
  phase: string;
  progress: number;
  detail?: string;
  title?: string;
  meta?: string;
}): void {
  const percent = Math.round(state.progress * 100);
  const fill = el<HTMLElement>("an-progress-fill");
  fill.style.width = `${percent}%`;
  el<HTMLElement>("an-phase").textContent = state.phase;
  el<HTMLElement>("an-percent").textContent = `${percent} %`;
  el<HTMLElement>("an-progress").setAttribute("aria-valuenow", String(percent));
  if (state.detail !== undefined) el<HTMLElement>("an-detail").textContent = state.detail;
  if (state.title !== undefined) el<HTMLElement>("an-title").textContent = state.title;
  if (state.meta !== undefined) el<HTMLElement>("an-meta").textContent = state.meta;
}

export function setShowError(title: string, message: string, detail?: string): void {
  el<HTMLElement>("err-title").textContent = title;
  el<HTMLElement>("err-message").textContent = message;
  const details = el<HTMLElement>("err-details");
  const text = el<HTMLElement>("err-detail-text");
  if (detail !== undefined && detail.length > 0) {
    text.textContent = detail;
    details.hidden = false;
  } else {
    details.hidden = true;
  }
}

function setHidden(node: Element | null, hidden: boolean): void {
  if (node === null) return;
  if (hidden) node.setAttribute("hidden", "");
  else node.removeAttribute("hidden");
}

export function setPlaying(playing: boolean): void {
  setHidden(document.querySelector(".icon-play"), playing);
  setHidden(document.querySelector(".icon-pause"), !playing);
  el<HTMLElement>("btn-play").setAttribute("aria-label", playing ? "Pause" : "Lecture");
  const nowPlaying = document.querySelector(".now-playing");
  if (nowPlaying !== null) nowPlaying.classList.toggle("is-paused", !playing);
}

export function setDropError(message: string | null): void {
  const node = el<HTMLElement>("drop-error");
  if (message === null) {
    node.hidden = true;
    node.textContent = "";
    return;
  }
  node.textContent = message;
  node.hidden = false;
}
