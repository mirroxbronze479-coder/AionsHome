import argparse
import re
import time
from pathlib import Path


SEGMENT_RE = re.compile(r"^(?P<base>tm_[A-Za-z0-9_-]+)_s(?P<seq>\d+)\.mp3$")


def collect_groups(cache_dir: Path):
    groups: dict[str, dict[int, Path]] = {}
    for path in cache_dir.glob("*.mp3"):
        match = SEGMENT_RE.match(path.name)
        if not match:
            continue
        base = match.group("base")
        seq = int(match.group("seq"))
        groups.setdefault(base, {})[seq] = path
    return groups


def is_complete(seqs: set[int]) -> bool:
    if not seqs or 0 not in seqs:
        return False
    return seqs == set(range(max(seqs) + 1))


def merge_group(base: str, segments: dict[int, Path], cache_dir: Path, delete_segments: bool) -> tuple[str, int, int]:
    ordered = [segments[i] for i in range(max(segments) + 1)]
    merged_path = cache_dir / f"{base}.mp3"
    tmp_path = cache_dir / f"{base}.tmp"
    expected_size = sum(path.stat().st_size for path in ordered)

    with tmp_path.open("wb") as out:
        for path in ordered:
            out.write(path.read_bytes())
    actual_size = tmp_path.stat().st_size
    if actual_size != expected_size:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(f"merged size mismatch for {base}: expected {expected_size}, got {actual_size}")

    tmp_path.replace(merged_path)

    if delete_segments:
        for path in ordered:
            path.unlink(missing_ok=True)

    return str(merged_path), len(ordered), actual_size


def main():
    parser = argparse.ArgumentParser(description="Merge existing theater TTS segment files by message id.")
    parser.add_argument("--cache-dir", default="data/theater_tts_cache")
    parser.add_argument("--delete-segments", action="store_true")
    parser.add_argument("--skip-recent-seconds", type=int, default=2 * 60 * 60)
    args = parser.parse_args()

    cache_dir = Path(args.cache_dir)
    if not cache_dir.is_absolute():
        cache_dir = Path(__file__).resolve().parents[1] / cache_dir
    cache_dir = cache_dir.resolve()

    groups = collect_groups(cache_dir)
    now = time.time()
    stats = {
        "groups": len(groups),
        "merged": 0,
        "segments_merged": 0,
        "bytes_written": 0,
        "skipped_incomplete": 0,
        "skipped_recent": 0,
        "skipped_existing": 0,
        "failed": 0,
    }

    for base, segments in sorted(groups.items()):
        seqs = set(segments)
        if not is_complete(seqs):
            stats["skipped_incomplete"] += 1
            print(f"skip incomplete: {base} seqs={sorted(seqs)[:6]}... max={max(seqs) if seqs else -1}")
            continue
        if args.skip_recent_seconds > 0:
            newest_mtime = max(path.stat().st_mtime for path in segments.values())
            if now - newest_mtime < args.skip_recent_seconds:
                stats["skipped_recent"] += 1
                print(f"skip recent: {base}")
                continue
        merged_path = cache_dir / f"{base}.mp3"
        if merged_path.exists() and not args.delete_segments:
            stats["skipped_existing"] += 1
            print(f"skip existing merged file: {base}")
            continue
        try:
            _path, count, size = merge_group(base, segments, cache_dir, args.delete_segments)
            stats["merged"] += 1
            stats["segments_merged"] += count
            stats["bytes_written"] += size
            print(f"merged: {base} segments={count} size={size}")
        except Exception as exc:
            stats["failed"] += 1
            print(f"failed: {base}: {exc}")

    print("summary:", stats)


if __name__ == "__main__":
    main()
