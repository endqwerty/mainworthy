import { reasonBesideShards, type ShardWait, shardWaitTitle } from "../../core/runs.ts";
import "./shards.css";

/**
 * A gate's reason, with the shards it waits for drawn: one strip a job, a cell a shard, the missing ones outlined.
 * The reason then counts the shards, and each strip's title spells out which reported and which are awaited. A
 * compact strip, for a list row, draws the cells alone, before the words.
 */
export function GateReason({
	reason,
	waiting = [],
	compact = false,
}: {
	reason: string;
	waiting?: readonly ShardWait[] | undefined;
	compact?: boolean;
}) {
	const text = <span>{reasonBesideShards(reason, waiting)}</span>;
	const strips = <ShardWaits waiting={waiting} compact={compact} />;
	// A row cuts its end off when it is narrow, so there the cells come first.
	return compact ? (
		<>
			{strips}
			{text}
		</>
	) : (
		<>
			{text}
			{strips}
		</>
	);
}

/**
 * The strips alone, for a reason that is drawn apart from them. Only a full strip writes its words out on a phone,
 * so a compact one belongs in a row whose own page shows the full strip.
 */
export function ShardWaits({ waiting, compact = false }: { waiting: readonly ShardWait[]; compact?: boolean }) {
	if (waiting.length === 0) return null;
	return (
		<span className={`shard-waits${compact ? " compact" : ""}`}>
			{waiting.map((wait) => (
				<ShardStrip key={`${wait.env}\u0000${wait.job}`} wait={wait} compact={compact} />
			))}
		</span>
	);
}

function ShardStrip({ wait, compact }: { wait: ShardWait; compact: boolean }) {
	const said = shardWaitTitle(wait);
	const missing = new Set(wait.missing);
	// A number in each cell reads at a glance up to two dozen shards; past that the cells alone show the gaps.
	const numbered = !compact && wait.of <= 24;
	return (
		<span className="shard-strip" role="img" title={said} aria-label={said}>
			{!compact && (
				<span className="shard-job">
					{wait.job || "(unnamed)"}
					{wait.env && <span className="dim"> · {wait.env}</span>}
				</span>
			)}
			{compact && wait.of > 24 ? (
				// A row has no room for a cell each of many shards: the share reported is a bar.
				<span className="shard-bar" aria-hidden="true">
					<span className="shard-bar-fill" style={{ width: `${(100 * (wait.of - wait.missing.length)) / wait.of}%` }} />
				</span>
			) : (
				<span className="shard-cells" aria-hidden="true">
					{Array.from({ length: wait.of }, (_, i) => i + 1).map((n) => (
						<span key={n} className={missing.has(n) ? "shard-missing" : "shard-reported"}>
							{numbered ? n : null}
						</span>
					))}
				</span>
			)}
			{!compact && (
				<>
					<span className="shard-count" aria-hidden="true">
						{wait.of - wait.missing.length}/{wait.of}
					</span>
					{/* A phone has no hover: there the words are written under the strip. */}
					<span className="shard-said">{said}</span>
				</>
			)}
		</span>
	);
}
