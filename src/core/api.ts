import type { Analysis } from "../types";

export interface JobResponse {
  jobId: string;
  status: JobStatus;
  progress: number;
  phase: string;
  message?: string;
  filename?: string;
  sizeBytes?: number;
  duration?: number;
  result?: { analysis: Analysis };
  error?: { code: string; message: string; detail?: string };
}

export type JobStatus = "queued" | "running" | "done" | "error";

export interface Limits {
  maxFileBytes: number;
  maxDurationSec: number;
}

export interface HealthResponse {
  status: "ok";
  limits: Limits;
  formats: string[];
  tools: { librosa: string; soundfile: string; ffmpeg: boolean };
  audioRetention?: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly detail?: string;
  readonly status?: number;

  constructor(message: string, code = "api_error", detail?: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: { code: "bad_response", message: text.slice(0, 400) || "Réponse illisible du serveur." } };
  }
}

function toApiError(payload: unknown, status?: number): ApiError {
  const record = payload as { error?: { code?: string; message?: string; detail?: string }; detail?: string } | null;
  const code = record?.error?.code ?? "error";
  const message = record?.error?.message ?? record?.detail ?? `Le serveur a refusé la requête (${status ?? "?"}).`;
  return new ApiError(message, code, record?.error?.detail, status);
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const response = await fetch("/api/health", { signal });
  if (!response.ok) {
    throw new ApiError("Serveur d'analyse indisponible.", "server_unavailable", undefined, response.status);
  }
  return (await parseJson(response)) as HealthResponse;
}

/** Envoie le fichier avec la progression réelle de l'upload (0..1). */
function uploadFile(file: File, onUploadProgress: (ratio: number) => void, signal?: AbortSignal): Promise<JobResponse> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", "/api/analyze");
    request.responseType = "text";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onUploadProgress(clampRatio(event.loaded / event.total));
    };
    request.upload.onload = () => onUploadProgress(1);
    request.onload = () => {
      let payload: unknown;
      try {
        payload = JSON.parse(request.responseText) as unknown;
      } catch {
        reject(
          new ApiError(
            "Réponse illisible du serveur pendant l'envoi.",
            "bad_response",
            request.responseText.slice(0, 400),
          ),
        );
        return;
      }
      if (request.status >= 200 && request.status < 300) {
        resolve(payload as JobResponse);
        return;
      }
      reject(toApiError(payload, request.status));
    };
    request.onerror = () => reject(new ApiError("L'envoi a échoué : le serveur est injoignable.", "network"));
    request.ontimeout = () => reject(new ApiError("L'envoi a expiré.", "timeout"));
    request.onabort = () => reject(new ApiError("Envoi annulé.", "aborted"));
    if (signal !== undefined) {
      signal.addEventListener("abort", () => request.abort(), { once: true });
    }
    const body = new FormData();
    body.append("file", file, file.name);
    request.send(body);
  });
}

export async function fetchJob(jobId: string, signal?: AbortSignal): Promise<JobResponse> {
  const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal });
  if (response.status === 404) {
    throw new ApiError("Analyse introuvable ou expirée.", "job_not_found", undefined, 404);
  }
  if (!response.ok) throw toApiError(await parseJson(response), response.status);
  return (await parseJson(response)) as JobResponse;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ApiError("Analyse annulée.", "aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Envoie le fichier puis suit l'analyse jusqu'à son terme.
 * `onPhase` reçoit la progression réelle (upload puis phases d'analyse).
 */
export function uploadAndAnalyze(
  file: File,
  handlers: {
    onUploadProgress?: (ratio: number) => void;
    onPhase?: (state: { progress: number; phase: string; detail: string }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ jobId: string; analysis: Analysis }> {
  const { onUploadProgress, onPhase, signal } = handlers;
  return new Promise((resolve, reject) => {
    uploadFile(file, (ratio) => onUploadProgress?.(ratio), signal)
      .then(async (job) => {
        try {
          const analysis = await pollJob(job.jobId, onPhase, signal);
          resolve({ jobId: job.jobId, analysis });
        } catch (error) {
          reject(error);
        }
      })
      .catch(reject);
  });
}

async function pollJob(
  jobId: string,
  onPhase: ((state: { progress: number; phase: string; detail: string }) => void) | undefined,
  signal?: AbortSignal,
): Promise<Analysis> {
  const started = Date.now();
  const timeoutMs = 12 * 60 * 1000;
  for (;;) {
    if (signal?.aborted === true) throw new ApiError("Analyse annulée.", "aborted");
    const job = await fetchJob(jobId, signal);
    if (job.status === "done") {
      const analysis = job.result?.analysis;
      if (analysis === undefined) throw new ApiError("Analyse terminée mais données absentes.", "empty_result");
      onPhase?.({ progress: 1, phase: "Terminé", detail: "Spectacle prêt." });
      return analysis;
    }
    if (job.status === "error") {
      throw new ApiError(
        job.error?.message ?? "L'analyse a échoué.",
        job.error?.code ?? "analysis_error",
        job.error?.detail,
      );
    }
    onPhase?.({ progress: job.progress, phase: job.phase, detail: job.message ?? "" });
    if (Date.now() - started > timeoutMs) {
      throw new ApiError("L'analyse prend trop de temps, essaie un morceau plus court.", "timeout");
    }
    await delay(400, signal);
  }
}

export function audioUrl(jobId: string): string {
  return `/api/track/${encodeURIComponent(jobId)}`;
}

/** Récupère une analyse déjà faite (rejeu sans nouvelle analyse). */
export async function fetchAnalysis(jobId: string, signal?: AbortSignal): Promise<Analysis> {
  const job = await fetchJob(jobId, signal);
  const analysis = job.result?.analysis;
  if (analysis === undefined || job.status !== "done") {
    throw new ApiError("Analyse indisponible.", "job_not_found");
  }
  return analysis;
}

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export interface ResolveRequest {
  title: string;
  artist?: string;
  durationSec?: number;
}

export async function submitResolve(
  request: ResolveRequest,
  signal?: AbortSignal,
): Promise<JobResponse> {
  const response = await fetch("/api/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: request.title,
      artist: request.artist ?? "",
      duration_sec: request.durationSec,
    }),
    signal,
  });
  if (!response.ok) {
    throw toApiError(await parseJson(response), response.status);
  }
  return (await parseJson(response)) as JobResponse;
}

export function resolveAndAnalyze(
  title: string,
  artist: string,
  durationSec: number | undefined,
  handlers: {
    onPhase?: (state: { progress: number; phase: string; detail: string }) => void;
    signal?: AbortSignal;
  } = {},
): Promise<{ jobId: string; analysis: Analysis }> {
  const { onPhase, signal } = handlers;
  return new Promise((resolve, reject) => {
    submitResolve({ title, artist, durationSec }, signal)
      .then(async (job) => {
        try {
          const analysis = await pollJob(job.jobId, onPhase, signal);
          resolve({ jobId: job.jobId, analysis });
        } catch (error) {
          reject(error);
        }
      })
      .catch(reject);
  });
}
