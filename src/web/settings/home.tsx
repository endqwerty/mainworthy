import { useState } from "react";
import { Home, readHome, saveHome } from "../lib/home.ts";
import { useApp } from "../ui/context.tsx";
import { DocLink, Select } from "../ui/index.tsx";

export function YourHome() {
	const { project } = useApp();
	const [home, setHome] = useState(() => readHome(project));
	const [message, setMessage] = useState("");
	const changeHome = (next: Home): void => {
		setHome(next);
		setMessage("");
	};
	return (
		<>
			<h2>Your home</h2>
			<p className="dim">
				Choose where this project opens. This preference is yours, stored in this browser for this person and project.
				It does not follow you across browsers. <DocLink page="customize">About your home</DocLink>
			</p>
			<form
				className="settings-form"
				onSubmit={(event) => {
					event.preventDefault();
					const parsed = Home.safeParse(home);
					if (!parsed.success) {
						setMessage(
							"Use a run ref such as R-1, or a search with a valid tag and at most 1,000 characters per field.",
						);
						return;
					}
					setMessage(
						saveHome(project, parsed.data)
							? "Home saved in this browser. Press g h or choose Go home in the palette."
							: "This browser could not save your home. Your previous home is still in force.",
					);
				}}
			>
				<label>
					Home screen
					<Select
						aria-label="Home screen"
						className="form-input"
						value={home.kind}
						onChange={(event) => {
							const kind = event.target.value;
							if (kind === "suite" || kind === "queue") changeHome({ kind });
							else if (kind === "run") changeHome({ kind, ref: "" });
							else if (kind === "search") changeHome({ kind, text: "", folder: "", tag: "" });
						}}
					>
						<option value="suite">Suite</option>
						<option value="queue">Queue</option>
						<option value="run">A run</option>
						<option value="search">A saved search</option>
					</Select>
				</label>
				{home.kind === "run" && (
					<label>
						Home run
						<input
							className="form-input"
							value={home.ref}
							placeholder="R-1"
							required
							pattern="R-[1-9][0-9]*"
							onChange={(event) => changeHome({ ...home, ref: event.target.value })}
						/>
					</label>
				)}
				{home.kind === "search" && (
					<>
						<label>
							Home search text
							<input
								className="form-input"
								maxLength={1000}
								value={home.text}
								onChange={(event) => changeHome({ ...home, text: event.target.value })}
							/>
						</label>
						<label>
							Home search folder
							<input
								className="form-input"
								maxLength={1000}
								value={home.folder}
								onChange={(event) => changeHome({ ...home, folder: event.target.value })}
							/>
						</label>
						<label>
							Home search tag
							<input
								className="form-input"
								value={home.tag}
								onChange={(event) => changeHome({ ...home, tag: event.target.value })}
							/>
						</label>
						<p className="dim">
							The saved search keeps these filters and reads the current cases each time you go home.
						</p>
					</>
				)}
				<button type="submit" className="out">
					Save home
				</button>
				<p role="status" className="settings-message">
					{message}
				</p>
			</form>
		</>
	);
}
