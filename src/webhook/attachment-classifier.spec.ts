import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AttachmentClassifier } from './attachment-classifier';
import { AppEnv } from '../config/env.validation';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeClassifier() {
  const head = jest.fn();
  mockedAxios.create.mockReturnValue({ head } as unknown as ReturnType<typeof axios.create>);

  const env: Record<string, number> = { MEDIA_HEAD_TIMEOUT_MS: 5000 };
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService<AppEnv, true>;

  return { classifier: new AttachmentClassifier(config), head };
}

function ok(contentType: string) {
  return { status: 200, headers: { 'content-type': contentType } };
}

describe('AttachmentClassifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('configures axios with the head timeout, follows redirects, accepts any status', () => {
    makeClassifier();
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 5000, maxRedirects: 5 }),
    );
  });

  it('returns true when the Content-Type is video/mp4', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue(ok('video/mp4'));

    await expect(classifier.containsVideo(['https://cdn/x.mp4'], 'j1')).resolves.toBe(true);
  });

  it('returns true for any video/* subtype regardless of case', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue(ok('Video/Quicktime'));

    await expect(classifier.containsVideo(['https://cdn/x.mov'], 'j1')).resolves.toBe(true);
  });

  it('returns false for audio/mp4 (an audio in an mp4 container is kept)', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue(ok('audio/mp4'));

    await expect(classifier.containsVideo(['https://cdn/x.mp4'], 'j1')).resolves.toBe(false);
  });

  it('returns false for image/jpeg', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue(ok('image/jpeg'));

    await expect(classifier.containsVideo(['https://cdn/x.jpg'], 'j1')).resolves.toBe(false);
  });

  it('fail-open: returns false when the HEAD request throws', async () => {
    const { classifier, head } = makeClassifier();
    head.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));

    await expect(classifier.containsVideo(['https://cdn/x.mp4'], 'j1')).resolves.toBe(false);
  });

  it('fail-open: returns false on a non-2xx status (e.g. 405 HEAD not allowed)', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue({ status: 405, headers: {} });

    await expect(classifier.containsVideo(['https://cdn/x.mp4'], 'j1')).resolves.toBe(false);
  });

  it('fail-open: returns false when Content-Type is missing', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue({ status: 200, headers: {} });

    await expect(classifier.containsVideo(['https://cdn/x.mp4'], 'j1')).resolves.toBe(false);
  });

  it('returns false for an empty attachment list without probing', async () => {
    const { classifier, head } = makeClassifier();

    await expect(classifier.containsVideo([], 'j1')).resolves.toBe(false);
    expect(head).not.toHaveBeenCalled();
  });

  it('returns true when ANY attachment in a mixed set is a video', async () => {
    const { classifier, head } = makeClassifier();
    head
      .mockResolvedValueOnce(ok('image/jpeg'))
      .mockResolvedValueOnce(ok('video/mp4'));

    await expect(
      classifier.containsVideo(['https://cdn/a.jpg', 'https://cdn/b.mp4'], 'j1'),
    ).resolves.toBe(true);
    expect(head).toHaveBeenCalledTimes(2);
  });
});
