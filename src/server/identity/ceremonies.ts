/** Bounded ceremony memory. Under pressure a source with the largest share loses its oldest entry. */
export class Ceremonies<T extends { readonly deadline: number }> {
	private readonly entries = new Map<string, { value: T; owner: string; order: number }>();
	private readonly owners = new Map<string, Set<string>>();
	private order = 0;
	private nextExpiry = Number.POSITIVE_INFINITY;

	get(key: string): T | undefined {
		return this.entries.get(key)?.value;
	}

	*values(): IterableIterator<T> {
		for (const entry of this.entries.values()) yield entry.value;
	}

	delete(key: string): void {
		const entry = this.entries.get(key);
		if (!entry) return;
		this.entries.delete(key);
		const bucket = this.owners.get(entry.owner);
		bucket?.delete(key);
		if (bucket?.size === 0) this.owners.delete(entry.owner);
	}

	put(key: string, value: T, owner: string, now: number): void {
		this.delete(key);
		if (this.entries.size >= 10_000 && now >= this.nextExpiry) {
			this.nextExpiry = Number.POSITIVE_INFINITY;
			for (const [held, entry] of this.entries) {
				if (now >= entry.value.deadline) this.delete(held);
				else this.nextExpiry = Math.min(this.nextExpiry, entry.value.deadline);
			}
		}
		if (this.entries.size >= 10_000) {
			let selected: { owner: string; key: string; count: number; order: number } | undefined;
			for (const [source, bucket] of this.owners) {
				const oldest = bucket.values().next();
				if (oldest.done) continue;
				const entry = this.entries.get(oldest.value);
				if (!entry) throw new Error("ceremony owner index is inconsistent");
				if (
					!selected ||
					bucket.size > selected.count ||
					(bucket.size === selected.count &&
						(source === owner || (selected.owner !== owner && entry.order < selected.order)))
				)
					selected = { owner: source, key: oldest.value, count: bucket.size, order: entry.order };
			}
			if (!selected) throw new Error("a full ceremony store has an owner");
			this.delete(selected.key);
		}
		this.entries.set(key, { value, owner, order: this.order++ });
		let bucket = this.owners.get(owner);
		if (!bucket) {
			bucket = new Set();
			this.owners.set(owner, bucket);
		}
		bucket.add(key);
		this.nextExpiry = Math.min(this.nextExpiry, value.deadline);
	}
}
