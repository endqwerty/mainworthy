import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from "jose";

export type JobService = { audience: string; account: string };
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
/** Cloud Run checks invoker IAM before forwarding; the app also verifies the same service identity. */
export async function authenticateJob(
	header: string | null,
	service: JobService | undefined,
	keys: JWTVerifyGetKey = googleKeys,
): Promise<boolean> {
	if (!service || !header?.startsWith("Bearer ")) return false;
	try {
		const { payload } = await jwtVerify(header.slice(7), keys, {
			algorithms: ["RS256"],
			issuer: ["https://accounts.google.com", "accounts.google.com"],
			audience: service.audience,
			requiredClaims: ["exp", "iat", "sub", "email", "email_verified"],
			maxTokenAge: "1h",
		});
		return payload.email === service.account && payload.email_verified === true;
	} catch {
		return false;
	}
}
