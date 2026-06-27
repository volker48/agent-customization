import Foundation
import Security

public enum KeychainSecretKeyStoreError: Error, CustomStringConvertible {
  case unexpectedStatus(OSStatus)

  public var description: String {
    switch self {
    case .unexpectedStatus(let status):
      "Keychain secret key operation failed with status \(status)."
    }
  }
}

public struct KeychainSecretKeyStore: SecretKeyStore {
  private let service: String
  private let account: String

  public init(service: String = "works.earendil.pi.remote", account: String = "iroh-secret-key") {
    self.service = service
    self.account = account
  }

  public func loadSecretKey() throws -> Data? {
    var query = baseQuery()
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess else {
      throw KeychainSecretKeyStoreError.unexpectedStatus(status)
    }
    return item as? Data
  }

  public func saveSecretKey(_ data: Data) throws {
    SecItemDelete(baseQuery() as CFDictionary)

    var query = baseQuery()
    query[kSecValueData as String] = data
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw KeychainSecretKeyStoreError.unexpectedStatus(status)
    }
  }

  private func baseQuery() -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}
