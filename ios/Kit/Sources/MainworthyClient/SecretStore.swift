import Foundation
import Security
import Synchronization

/// Where the one secret the app holds is kept: the session cookie, with the address it is for.
package protocol SecretStore: Sendable {
	func load() -> Data?
	/// Stores the secret, or removes it when given nil.
	func save(_ secret: Data?)
}

/// The device's keychain. The item stays when the app is installed again, which a free developer account
/// makes necessary every seven days, so the person stays signed in across it. It is readable once the device
/// was unlocked after a start, and is not copied to another device.
package struct KeychainStore: SecretStore {
	private let service: String

	package init(service: String) {
		self.service = service
	}

	private var query: [CFString: Any] {
		[kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: "session"]
	}

	package func load() -> Data? {
		var found: CFTypeRef?
		let asked = query.merging([kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne]) { _, new in new }
		return SecItemCopyMatching(asked as CFDictionary, &found) == errSecSuccess ? found as? Data : nil
	}

	package func save(_ secret: Data?) {
		SecItemDelete(query as CFDictionary)
		guard let secret else { return }
		let item = query.merging([
			kSecValueData: secret,
			kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
		]) { _, new in new }
		SecItemAdd(item as CFDictionary, nil)
	}
}

/// A secret kept for as long as the process runs: for tests, and for a preview.
package final class MemoryStore: SecretStore {
	private let secret = Mutex<Data?>(nil)

	package init() {}

	package func load() -> Data? {
		secret.withLock { $0 }
	}

	package func save(_ secret: Data?) {
		self.secret.withLock { $0 = secret }
	}
}
