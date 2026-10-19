import { type ResultStep, stepHeat } from "../../core/results.ts";
import { ResultAttachments } from "./attachments.tsx";
import "./result-trail.css";

const time = (ms: number | undefined) => (ms === undefined ? null : `${ms.toLocaleString()} ms`);
export function ResultTrail({ result, steps }: { result: number; steps: ResultStep[] | null }) {
	if (!steps?.length) return null;
	return (
		<ol className="result-trail" aria-label="Step trail">
			{steps.map((step, index) => (
				<li
					// biome-ignore lint/suspicious/noArrayIndexKey: A result is immutable; its step ordinal is its identity.
					key={`${result}:${index}`}
					style={{
						backgroundColor: `color-mix(in srgb, var(--trail-tint) ${Math.round(stepHeat(steps, step) * 100)}%, var(--panel))`,
					}}
				>
					<div className="trail-step">
						<strong>Step {step.step}</strong>
						<span>{step.outcome}</span>
						{step.durationMs !== undefined && <span>{time(step.durationMs)}</span>}
					</div>
					{Boolean(step.actions?.length) && (
						<ul aria-label={`Actions for step ${step.step}`}>
							{step.actions?.map((action, ordinal) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: Actions are immutable observations identified by result, step and ordinal.
								<li key={`${result}:${index}:${ordinal}`}>
									<span className="trail-action">{action.text}</span>
									{action.outcome && <span>{action.outcome}</span>}
									{action.durationMs !== undefined && <span>{time(action.durationMs)}</span>}
								</li>
							))}
						</ul>
					)}
					{step.attachment !== undefined && (
						<details className="trail-screenshot">
							<summary>Screenshot for step {step.step}</summary>
							<ResultAttachments result={result} index={step.attachment} />
						</details>
					)}
				</li>
			))}
		</ol>
	);
}
