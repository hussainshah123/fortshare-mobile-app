import {
  dateGroupOf,
  formatBytes,
  formatDuration,
  formatEta,
  formatRelativeTime,
  formatSpeed,
  groupByDate,
  percentOf,
  pluralize,
  truncateMiddle,
} from '../src/utils/format';
import { categoryOf, extensionOf, guessMimeType } from '../src/utils/files';
import { SpeedTracker } from '../src/network/transfer/speed';

describe('formatBytes', () => {
  it('scales units and sheds precision as numbers grow', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
    // 428 MB, not 428.0 MB.
    expect(formatBytes(428 * 1024 * 1024)).toBe('428 MB');
    expect(formatBytes(1.2 * 1024 ** 3)).toBe('1.2 GB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.0 TB');
  });

  it('treats nonsense as zero rather than rendering NaN', () => {
    expect(formatBytes(-1)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('0 B');
  });
});

describe('formatSpeed and formatEta', () => {
  it('renders a rate', () => {
    expect(formatSpeed(22.4 * 1024 * 1024)).toBe('22.4 MB/s');
    expect(formatSpeed(0)).toBe('—');
  });

  it('renders remaining time at sensible granularity', () => {
    expect(formatEta(null)).toBe('—');
    expect(formatEta(0.4)).toBe('almost done');
    expect(formatEta(24)).toBe('24 sec');
    expect(formatEta(190)).toBe('3 min 10 sec');
    expect(formatEta(120)).toBe('2 min');
    expect(formatEta(3900)).toBe('1 hr 5 min');
    expect(formatEta(3600)).toBe('1 hr');
  });

  it('renders a completed duration', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(450)).toBe('450 ms');
    expect(formatDuration(72_000)).toBe('1 min 12 sec');
  });
});

describe('relative time', () => {
  const NOW = new Date('2026-09-07T14:00:00Z').getTime();

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('describes recent instants', () => {
    expect(formatRelativeTime(NOW)).toBe('Just now');
    expect(formatRelativeTime(NOW - 30_000)).toBe('Just now');
    expect(formatRelativeTime(NOW - 5 * 60_000)).toBe('5 min ago');
    expect(formatRelativeTime(NOW - 3 * 3_600_000)).toBe('3 hours ago');
  });

  it('uses calendar days, not a rolling 24 hours', () => {
    // 11pm "yesterday" read at 2pm today is Yesterday, not "15 hours ago".
    const yesterdayEvening = new Date('2026-09-06T23:00:00Z').getTime();
    expect(formatRelativeTime(yesterdayEvening)).toBe('Yesterday');

    const threeDaysAgo = new Date('2026-09-04T09:42:00Z').getTime();
    expect(formatRelativeTime(threeDaysAgo)).toBe('3 days ago');
  });

  it('handles never and future timestamps', () => {
    expect(formatRelativeTime(0)).toBe('Never');
    expect(formatRelativeTime(NOW + 60_000)).toBe('Just now');
  });

  it('groups by calendar bucket', () => {
    expect(dateGroupOf(NOW)).toBe('Today');
    expect(dateGroupOf(new Date('2026-09-06T23:00:00Z').getTime())).toBe('Yesterday');
    expect(dateGroupOf(new Date('2026-09-03T10:00:00Z').getTime())).toBe('This Week');
    expect(dateGroupOf(new Date('2026-08-01T10:00:00Z').getTime())).toBe('Older');
  });

  it('preserves order within each group and drops empty groups', () => {
    const items = [
      { id: 'a', at: NOW },
      { id: 'b', at: new Date('2026-08-01T10:00:00Z').getTime() },
      { id: 'c', at: NOW - 60_000 },
    ];
    const sections = groupByDate(items, (item) => item.at);

    expect(sections.map((section) => section.title)).toEqual(['Today', 'Older']);
    expect(sections[0]!.data.map((item) => item.id)).toEqual(['a', 'c']);
  });
});

describe('small helpers', () => {
  it('pluralises', () => {
    expect(pluralize(1, 'file')).toBe('1 file');
    expect(pluralize(3, 'file')).toBe('3 files');
    expect(pluralize(2, 'transfer', 'transfers')).toBe('2 transfers');
  });

  it('clamps percentages', () => {
    expect(percentOf(50, 100)).toBe(50);
    expect(percentOf(150, 100)).toBe(100);
    expect(percentOf(-5, 100)).toBe(0);
    // Avoids the divide-by-zero that would otherwise render NaN%.
    expect(percentOf(10, 0)).toBe(0);
  });

  it('truncates the middle so the extension stays visible', () => {
    expect(truncateMiddle('short.mp4', 28)).toBe('short.mp4');
    const long = truncateMiddle('a-really-very-long-holiday-video-name.mp4', 20);
    expect(long).toContain('…');
    expect(long.endsWith('.mp4')).toBe(true);
  });
});

describe('file categorisation', () => {
  it('reads the extension', () => {
    expect(extensionOf('Vacation.MP4')).toBe('mp4');
    expect(extensionOf('noextension')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });

  it('prefers the MIME type, falling back to the extension', () => {
    expect(categoryOf('x.bin', 'image/png')).toBe('photos');
    expect(categoryOf('x.bin', 'video/mp4')).toBe('videos');
    expect(categoryOf('x.bin', 'audio/mpeg')).toBe('music');
    // The common case: a provider that reports octet-stream for everything.
    expect(categoryOf('Vacation.mp4', 'application/octet-stream')).toBe('videos');
    expect(categoryOf('app.apk', 'application/octet-stream')).toBe('apk');
    expect(categoryOf('Project.zip', 'application/octet-stream')).toBe('archives');
    expect(categoryOf('Report.pdf', 'application/octet-stream')).toBe('documents');
    expect(categoryOf('mystery.xyz', 'application/octet-stream')).toBe('other');
  });

  it('guesses a usable MIME type', () => {
    expect(guessMimeType('a.jpg')).toBe('image/jpeg');
    expect(guessMimeType('a.mov')).toBe('video/quicktime');
    expect(guessMimeType('a.mp3')).toBe('audio/mpeg');
    expect(guessMimeType('a.pdf')).toBe('application/pdf');
    expect(guessMimeType('a.apk')).toBe('application/vnd.android.package-archive');
    expect(guessMimeType('a.unknown')).toBe('application/octet-stream');
  });
});

describe('SpeedTracker', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('smooths towards the true rate', () => {
    const tracker = new SpeedTracker();
    tracker.start(0);

    // 1 MB per 500ms = 2 MB/s, fed repeatedly.
    for (let i = 1; i <= 30; i++) {
      jest.setSystemTime(i * 500);
      tracker.update(i * 1024 * 1024);
    }

    expect(tracker.current).toBeGreaterThan(1.8 * 1024 * 1024);
    expect(tracker.current).toBeLessThan(2.2 * 1024 * 1024);
  });

  it('ignores samples that arrive too close together', () => {
    const tracker = new SpeedTracker();
    tracker.start(0);
    jest.setSystemTime(50);
    // Below the minimum sample window, so this must not register as a
    // 20 MB/s burst.
    expect(tracker.update(1024 * 1024)).toBe(0);
  });

  it('computes an ETA from the smoothed rate', () => {
    const tracker = new SpeedTracker();
    tracker.start(0);
    jest.setSystemTime(1000);
    tracker.update(1024 * 1024); // ~1 MB/s

    const eta = tracker.eta(1024 * 1024, 11 * 1024 * 1024);
    expect(eta).toBeCloseTo(10, 0);
    expect(tracker.eta(100, 100)).toBe(0);
  });

  it('reports no ETA until a rate is known', () => {
    expect(new SpeedTracker().eta(0, 1000)).toBeNull();
  });

  it('restarts cleanly when a transfer resumes at a lower offset', () => {
    const tracker = new SpeedTracker();
    tracker.start(5_000_000);
    jest.setSystemTime(1000);
    tracker.update(6_000_000);
    expect(tracker.current).toBeGreaterThan(0);

    // A resume can legitimately move the counter backwards.
    jest.setSystemTime(2000);
    expect(tracker.update(1_000_000)).toBe(0);
  });

  it('averages over the whole transfer, excluding the pause', () => {
    const tracker = new SpeedTracker();
    tracker.start(0);
    jest.setSystemTime(2000);
    tracker.update(2 * 1024 * 1024);

    // A long pause, then a resume: elapsed time is kept so the average
    // reflects the whole transfer rather than restarting.
    jest.setSystemTime(60_000);
    tracker.resumeFrom(2 * 1024 * 1024);
    expect(tracker.elapsedMs).toBe(60_000);
  });
});
