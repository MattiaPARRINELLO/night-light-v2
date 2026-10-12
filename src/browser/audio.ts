/**
 * Moteur de lecture : une seule source de vérité pour la position musicale.
 * C'est `audio.currentTime` qui pilote le spectacle, ce qui garantit une
 * synchronisation exacte après une pause, une reprise ou un retour en arrière.
 */
export class AudioEngine {
  readonly element: HTMLAudioElement;
  private endedHandlers: Array<() => void> = [];

  constructor() {
    this.element = document.createElement("audio");
    this.element.preload = "auto";
    this.element.volume = 0.8;
    this.element.setAttribute("aria-hidden", "true");
    this.element.style.display = "none";
    document.body.append(this.element);
  }

  load(src: string): void {
    this.element.src = src;
    this.element.load();
  }

  async play(): Promise<void> {
    try {
      await this.element.play();
    } catch (error) {
      const name = (error as Error).name;
      if (name === "AbortError") return;
      throw error;
    }
  }

  pause(): void {
    this.element.pause();
  }

  seek(time: number): void {
    if (Number.isFinite(time)) this.element.currentTime = Math.max(0, time);
  }

  setVolume(volume: number): void {
    this.element.volume = Math.min(1, Math.max(0, volume));
  }

  get currentTime(): number {
    return this.element.currentTime;
  }

  get duration(): number {
    const value = this.element.duration;
    return Number.isFinite(value) ? value : 0;
  }

  get paused(): boolean {
    return this.element.paused;
  }

  onEnded(handler: () => void): void {
    this.endedHandlers.push(handler);
    this.element.addEventListener("ended", handler);
  }

  on(
    event: "play" | "pause" | "timeupdate" | "loadedmetadata" | "error" | "durationchange",
    handler: () => void,
  ): void {
    this.element.addEventListener(event, handler);
  }

  dispose(): void {
    for (const handler of this.endedHandlers) this.element.removeEventListener("ended", handler);
    this.endedHandlers = [];
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.load();
  }
}
