export type PlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "error";

export interface PlaybackState {
  status: PlaybackStatus;
  speed: number;
}

interface PlayableAudio {
  currentTime: number;
  playbackRate: number;
  onended: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

interface PlaybackDependencies {
  createAudio: (url: string) => PlayableAudio;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  onStateChange: (state: PlaybackState) => void;
}

export class PlaybackController {
  private readonly dependencies: PlaybackDependencies;
  private audio: PlayableAudio | null = null;
  private objectUrl: string | null = null;
  private operation = 0;
  private state: PlaybackState = { status: "idle", speed: 1 };

  constructor(dependencies: PlaybackDependencies) {
    this.dependencies = dependencies;
  }

  getState(): PlaybackState {
    return this.state;
  }

  async play(blob: Blob): Promise<void> {
    this.releaseAudio();
    const operation = ++this.operation;
    this.updateStatus("loading");

    const objectUrl = this.dependencies.createObjectUrl(blob);
    const audio = this.dependencies.createAudio(objectUrl);
    audio.playbackRate = this.state.speed;
    audio.onended = () => {
      if (this.audio === audio) this.updateStatus("paused");
    };
    this.objectUrl = objectUrl;
    this.audio = audio;

    try {
      await audio.play();
      if (operation === this.operation && this.audio === audio) {
        this.updateStatus("playing");
      }
    } catch {
      if (operation === this.operation && this.audio === audio) {
        this.releaseAudio();
        this.updateStatus("error");
      }
    }
  }

  stop(): void {
    if (!this.audio) return;
    this.operation += 1;
    this.audio.pause();
    this.audio.currentTime = 0;
    this.updateStatus("paused");
  }

  async replay(): Promise<void> {
    if (!this.audio) return;
    const operation = ++this.operation;
    this.audio.currentTime = 0;
    this.updateStatus("loading");

    try {
      await this.audio.play();
      if (operation === this.operation && this.audio) {
        this.updateStatus("playing");
      }
    } catch {
      if (operation === this.operation) this.updateStatus("error");
    }
  }

  setSpeed(speed: number): void {
    if (!Number.isFinite(speed) || speed <= 0) return;
    this.state = { ...this.state, speed };
    if (this.audio) this.audio.playbackRate = speed;
    this.dependencies.onStateChange(this.state);
  }

  reset(): void {
    this.operation += 1;
    this.releaseAudio();
    this.updateStatus("idle");
  }

  private releaseAudio(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.onended = null;
      this.audio = null;
    }
    if (this.objectUrl) {
      this.dependencies.revokeObjectUrl(this.objectUrl);
      this.objectUrl = null;
    }
  }

  private updateStatus(status: PlaybackStatus): void {
    this.state = { ...this.state, status };
    this.dependencies.onStateChange(this.state);
  }
}
