import Foundation
import MainworthyClient
import TestSupport
import Testing
@testable import MainworthyScreens

@Suite(.enabled(if: Live.isRunning))
@MainActor
struct ProviderSignInTests {
	@Test func aLimitedProviderCallbackShowsTheWaitAndLeavesTheFormReadyToRetry() async throws {
		for (seconds, sentence) in [(1, "Too many attempts. Try again in 1 second."), (8, "Too many attempts. Try again in 8 seconds.")] {
			let store = MemoryStore()
			var signedIn = false
			let form = SignInForm(instance: Live.instance, notice: nil, connect: { instance in
				Server(instance: instance, secrets: store)
			}, onSignedIn: { _, _ in signedIn = true })
			await form.loadMethods()
			#expect(form.providerName == "Example ID")
			await form.signInWithProvider { url, _ in
				let transport = URLSessionTransport()
				let (_, authorized) = try await transport.send(URLRequest(url: url))
				let back = try #require(authorized.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)))
				let (_, done) = try await transport.send(URLRequest(url: back))
				let callback = try #require(done.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)))
				var parts = try #require(URLComponents(url: callback, resolvingAgainstBaseURL: false))
				let state = try #require(parts.queryItems?.first(where: { $0.name == "state" }))
				parts.queryItems = [state, URLQueryItem(name: "error", value: "limited"), URLQueryItem(name: "retryAfter", value: String(seconds))]
				return try #require(parts.url)
			}
			#expect(form.notice == sentence)
			#expect(!signedIn)
			#expect(!form.isWorking)
			#expect(store.load() == nil)
		}
	}

	@Test func aRefusedProviderKeepsThePasswordAndPointsToPasswordSignIn() async {
		let store = MemoryStore()
		var signedIn = false
		let form = SignInForm(instance: Live.instance, notice: nil, connect: { instance in
			Server(instance: instance, secrets: store)
		}, onSignedIn: { _, account in signedIn = account.name == Live.name })
		await form.loadMethods()
		#expect(form.providerName == "Example ID")
		form.name = Live.name
		form.password = Live.password
		await form.signInWithProvider { _, _ in
			throw ClientError.refused(code: "unauthenticated", message: "That did not sign you in through the identity provider.")
		}
		#expect(form.notice == "That did not sign you in through the identity provider. Try again, or use your password.")
		#expect(form.canSubmit && form.name == Live.name && form.password == Live.password)
		#expect(!signedIn && store.load() == nil)
		await form.submit()
		#expect(signedIn && form.password.isEmpty && store.load() != nil)
	}

	@Test func cancellingTheProviderLeavesTheFormSignedOutAndReadyToRetry() async throws {
		let store = MemoryStore()
		var signedInAs: String?
		var opened: (path: String, scheme: String)?
		let form = SignInForm(instance: Live.instance, notice: nil, connect: { instance in
			Server(instance: instance, secrets: store)
		}, onSignedIn: { _, account in signedInAs = account.name })
		await form.loadMethods()
		#expect(form.providerName == "Example ID")
		await form.signInWithProvider { url, scheme in
			opened = (url.path, scheme)
			throw CancellationError()
		}
		#expect(opened?.path == "/authorize" && opened?.scheme == "com.mainworthy.app")
		#expect(signedInAs == nil)
		#expect(!form.isWorking)
		#expect(form.notice == nil)
		#expect(store.load() == nil)
		await form.signInWithProvider { url, _ in
			let transport = URLSessionTransport()
			let (_, authorized) = try await transport.send(URLRequest(url: url))
			let back = try #require(authorized.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)))
			let (_, done) = try await transport.send(URLRequest(url: back))
			return try #require(done.value(forHTTPHeaderField: "Location").flatMap(URL.init(string:)))
		}
		#expect(signedInAs == Live.name)
		let kept = try #require(Server.kept(in: store))
		#expect(try await kept.account().name == Live.name)
	}
}
