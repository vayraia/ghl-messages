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

  it('classifies a video/mp4 Content-Type as a video', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue(ok('video/mp4'));

    await expect(classifier.partitionVideos(['https://cdn/x.mp4'], 'j1')).resolves.toEqual({
      videoUrls: ['https://cdn/x.mp4'],
      keptUrls: [],
    });
  });

  it('classifies any video/* subtype as a video regardless of case', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue(ok('Video/Quicktime'));

    await expect(classifier.partitionVideos(['https://cdn/x.mov'], 'j1')).resolves.toEqual({
      videoUrls: ['https://cdn/x.mov'],
      keptUrls: [],
    });
  });

  it('keeps audio/mp4 (an audio in an mp4 container is not a video)', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue(ok('audio/mp4'));

    await expect(classifier.partitionVideos(['https://cdn/x.mp4'], 'j1')).resolves.toEqual({
      videoUrls: [],
      keptUrls: ['https://cdn/x.mp4'],
    });
  });

  it('keeps image/jpeg', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue(ok('image/jpeg'));

    await expect(classifier.partitionVideos(['https://cdn/x.jpg'], 'j1')).resolves.toEqual({
      videoUrls: [],
      keptUrls: ['https://cdn/x.jpg'],
    });
  });

  it('fail-open: keeps the URL when the HEAD request throws', async () => {
    const { classifier, head } = makeClassifier();
    head.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));

    await expect(classifier.partitionVideos(['https://cdn/x.mp4'], 'j1')).resolves.toEqual({
      videoUrls: [],
      keptUrls: ['https://cdn/x.mp4'],
    });
  });

  it('fail-open: keeps the URL on a non-2xx status (e.g. 405 HEAD not allowed)', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue({ status: 405, headers: {} });

    await expect(classifier.partitionVideos(['https://cdn/x.mp4'], 'j1')).resolves.toEqual({
      videoUrls: [],
      keptUrls: ['https://cdn/x.mp4'],
    });
  });

  it('fail-open: keeps the URL when Content-Type is missing', async () => {
    const { classifier, head } = makeClassifier();
    head.mockResolvedValue({ status: 200, headers: {} });

    await expect(classifier.partitionVideos(['https://cdn/x.mp4'], 'j1')).resolves.toEqual({
      videoUrls: [],
      keptUrls: ['https://cdn/x.mp4'],
    });
  });

  it('returns empty partitions for an empty attachment list without probing', async () => {
    const { classifier, head } = makeClassifier();

    await expect(classifier.partitionVideos([], 'j1')).resolves.toEqual({
      videoUrls: [],
      keptUrls: [],
    });
    expect(head).not.toHaveBeenCalled();
  });

  it('splits a mixed set into video and non-video URLs, probed concurrently', async () => {
    const { classifier, head } = makeClassifier();
    head
      .mockResolvedValueOnce(ok('image/jpeg'))
      .mockResolvedValueOnce(ok('video/mp4'));

    await expect(
      classifier.partitionVideos(['https://cdn/a.jpg', 'https://cdn/b.mp4'], 'j1'),
    ).resolves.toEqual({
      videoUrls: ['https://cdn/b.mp4'],
      keptUrls: ['https://cdn/a.jpg'],
    });
    expect(head).toHaveBeenCalledTimes(2);
  });
});
