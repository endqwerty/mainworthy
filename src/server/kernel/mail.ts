import { z } from "zod";
import { EmailAddress } from "../../core/people.ts";

const MailConfig = z.object({
	host: z
		.string()
		.min(1)
		.max(253)
		.regex(/^[a-zA-Z0-9.:-]+$/)
		.refine((text) => text.trim() === text),
	port: z.coerce.number().int().min(1).max(65535),
	tls: z.enum(["tls", "starttls", "none"]),
	auth: z.object({ user: z.string().min(1).max(512), pass: z.string().min(1).max(1024) }).optional(),
	from: EmailAddress,
});
export type MailConfig = z.infer<typeof MailConfig>;

export function mailConfig(env: Record<string, string | undefined>): MailConfig | undefined {
	const names = ["SMTP_HOST", "SMTP_PORT", "SMTP_TLS", "SMTP_USER", "SMTP_PASSWORD", "MAIL_FROM"];
	if (names.every((name) => !env[`MAINWORTHY_${name}`])) return undefined;
	const result = MailConfig.safeParse({
		host: env.MAINWORTHY_SMTP_HOST,
		port: env.MAINWORTHY_SMTP_PORT || "587",
		tls: env.MAINWORTHY_SMTP_TLS || "starttls",
		from: env.MAINWORTHY_MAIL_FROM,
		...(env.MAINWORTHY_SMTP_USER || env.MAINWORTHY_SMTP_PASSWORD
			? { auth: { user: env.MAINWORTHY_SMTP_USER, pass: env.MAINWORTHY_SMTP_PASSWORD } }
			: {}),
	});
	if (!result.success)
		throw new Error(
			"Set valid MAINWORTHY_SMTP_HOST and MAINWORTHY_MAIL_FROM; SMTP_PORT is 1 to 65535, SMTP_TLS is tls, starttls or none, and SMTP_USER and SMTP_PASSWORD are set together",
		);
	if (!env.MAINWORTHY_PUBLIC_URL) throw new Error("Mail requires MAINWORTHY_PUBLIC_URL for links");
	return result.data;
}
