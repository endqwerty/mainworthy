import MainworthyScreens
import SwiftUI

struct SignInView: View {
	@Bindable var form: SignInForm
	@State private var authentication = ProviderAuthentication()
	@State private var passkeys = PasskeyAuthentication()
	@FocusState private var focus: Field?

	private enum Field {
		case name, password, code
	}

	var body: some View {
		NavigationStack {
			Form {
				if let notice = form.notice {
					Section {
						Label(notice, systemImage: "exclamationmark.circle")
							.foregroundStyle(Color.fail)
							.accessibilityIdentifier("sign-in-notice")
					}
				}
				if form.needsSecondFactor {
					Section {
						TextField("Authenticator or recovery code", text: $form.code)
							.textContentType(.oneTimeCode)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
							.focused($focus, equals: .code)
							.submitLabel(.go)
							.onSubmit(submit)
							.accessibilityIdentifier("sign-in-code")
					} header: {
						Text("One more step")
					} footer: {
						Text("Enter your authenticator code or an unused recovery code. This step lasts five minutes.")
					}
				} else {
					Section {
						// The two content types, with the associated domain the app's entitlements name, are what lets
						// the phone's password AutoFill (and 1Password through it) offer the login it keeps for the site.
						TextField("Name", text: $form.name)
							.textContentType(.username)
							.textInputAutocapitalization(.never)
							.autocorrectionDisabled()
							.focused($focus, equals: .name)
							.submitLabel(.next)
							.onSubmit { focus = .password }
							.accessibilityIdentifier("name")
						SecureField("Password", text: $form.password)
							.textContentType(.password)
							.focused($focus, equals: .password)
							.submitLabel(.go)
							.onSubmit(submit)
							.accessibilityIdentifier("password")
					} footer: {
						Text("Set a password or add a passkey in the web app, under Settings, Your sign-in.")
					}
				}
				Section {
					Button(action: submit) {
						HStack {
							Text(form.needsSecondFactor ? "Verify code" : "Sign in")
							if form.isWorking {
								Spacer()
								ProgressView()
							}
						}
					}
					.disabled(!form.canSubmit)
					.accessibilityIdentifier("sign-in")
					if form.needsSecondFactor {
						Button("Start again") {
							form.startAgain()
							focus = .password
						}
						.disabled(form.isWorking)
						.accessibilityIdentifier("sign-in-start-again")
					}
				}
				if let provider = form.providerName, !form.needsSecondFactor {
					Section {
						Button("Sign in with \(provider)") {
							focus = nil
							Task { await form.signInWithProvider(using: authentication.authenticate) }
						}
						.disabled(form.isWorking)
						.accessibilityIdentifier("provider-sign-in")
					}
				}
				if !form.needsSecondFactor {
					Section {
						Button("Sign in with a passkey") {
							focus = nil
							Task { await form.signInWithPasskey(using: passkeys) }
						}
						.disabled(form.isWorking)
						.accessibilityIdentifier("passkey-sign-in")
					}
				}
				Section {
					Link("Privacy", destination: form.privacyAddress)
						.accessibilityIdentifier("privacy")
				}
			}
			.navigationTitle("Mainworthy")
			.task { await form.loadMethods() }
			.onChange(of: form.needsSecondFactor) { _, needed in
				if needed { focus = .code }
			}
			.onDisappear {
				authentication.cancel()
				passkeys.cancel()
			}
		}
	}

	private func submit() {
		focus = nil
		Task { await form.submit() }
	}
}
