export type MediaRequest = {
  artifactId: string;
  scope: number;
  sequence: number;
};

type UrlFactory = {
  create: (blob: Blob) => string;
  revoke: (url: string) => void;
};

export class PrivateMediaLifecycle {
  private scope = 0;
  private sequence = new Map<string, number>();
  private urls = new Map<string, string>();

  constructor(private readonly factory: UrlFactory = {
    create: blob => URL.createObjectURL(blob),
    revoke: url => URL.revokeObjectURL(url),
  }) {}

  begin(artifactId: string): MediaRequest {
    const sequence = (this.sequence.get(artifactId) || 0) + 1;
    this.sequence.set(artifactId, sequence);
    return { artifactId, scope: this.scope, sequence };
  }

  isCurrent(request: MediaRequest): boolean {
    return request.scope === this.scope && this.sequence.get(request.artifactId) === request.sequence;
  }

  install(request: MediaRequest, blob: Blob): string | null {
    if (!this.isCurrent(request)) return null;
    const url = this.factory.create(blob);
    if (!this.isCurrent(request)) {
      this.factory.revoke(url);
      return null;
    }
    const previous = this.urls.get(request.artifactId);
    this.urls.set(request.artifactId, url);
    if (previous && previous !== url) this.factory.revoke(previous);
    return url;
  }

  clear(): void {
    this.scope += 1;
    this.sequence.clear();
    for (const url of this.urls.values()) this.factory.revoke(url);
    this.urls.clear();
  }
}
