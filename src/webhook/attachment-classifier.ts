import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';
import { AppEnv } from '../config/env.validation';

/**
 * Classifies inbound attachment URLs by their media type so the pipeline can
 * decide what to drop. GHL's inbound webhook does not carry a per-attachment
 * mime type (its `contentType`/`messageType` fields describe the CHANNEL, not
 * the media), and audio and video can share the same `.mp4` extension — so the
 * only reliable signal is the CDN's `Content-Type`, fetched with a HEAD.
 *
 * Fail-open by design: a video is dropped ONLY on a positively-confirmed
 * `video/*` Content-Type. Any ambiguity (HEAD error, timeout, non-2xx, a CDN
 * that doesn't support HEAD, or a missing/blank Content-Type) is treated as
 * "not a video" so we never silently discard audio/images/text on a flaky CDN.
 */
@Injectable()
export class AttachmentClassifier {
  private readonly logger = new Logger(AttachmentClassifier.name);
  private readonly client: AxiosInstance;

  constructor(config: ConfigService<AppEnv, true>) {
    const timeout: number = config.get('MEDIA_HEAD_TIMEOUT_MS', { infer: true });

    this.client = axios.create({
      timeout,
      // Inspect the status ourselves so a non-2xx is a fail-open "not video"
      // rather than a thrown error we'd have to catch per request.
      validateStatus: () => true,
      // Follow redirects: some CDNs 302 to a signed URL before serving the
      // asset (and its real Content-Type).
      maxRedirects: 5,
    });
  }

  /**
   * Splits the given URLs into positively-confirmed videos and the rest.
   * URLs are probed concurrently. On any error/ambiguity a URL counts as "not
   * video" (fail-open) and lands in `keptUrls`.
   */
  async partitionVideos(
    urls: string[],
    jobId: string,
  ): Promise<{ videoUrls: string[]; keptUrls: string[] }> {
    if (urls.length === 0) return { videoUrls: [], keptUrls: [] };

    const flags = await Promise.all(urls.map((url) => this.isVideo(url, jobId)));
    const videoUrls: string[] = [];
    const keptUrls: string[] = [];
    urls.forEach((url, i) => {
      (flags[i] ? videoUrls : keptUrls).push(url);
    });
    return { videoUrls, keptUrls };
  }

  private async isVideo(url: string, jobId: string): Promise<boolean> {
    let response;
    try {
      response = await this.client.head(url);
    } catch (err) {
      const axiosErr = err as AxiosError;
      this.logger.warn(
        { jobId, code: axiosErr.code ?? 'UNKNOWN', msg: axiosErr.message },
        'Attachment HEAD failed — treating as non-video (fail-open)',
      );
      return false;
    }

    if (response.status < 200 || response.status >= 300) {
      this.logger.warn(
        { jobId, status: response.status },
        'Attachment HEAD non-2xx — treating as non-video (fail-open)',
      );
      return false;
    }

    const contentType = String(response.headers['content-type'] ?? '')
      .toLowerCase()
      .trim();
    const isVideo = contentType.startsWith('video/');
    if (isVideo) {
      this.logger.log({ jobId, contentType }, 'Attachment classified as video');
    }
    return isVideo;
  }
}
