import Foundation

/// 解析数据目录：环境变量优先，其次是“设置 › 存储”写入的重定向配置，最后回退到 ~/.yovoice。
/// 配置文件位置必须与 Go 服务 store.ConfigFile 保持一致，否则迁移后重启会回到旧目录。
enum DataRoot {
    static func resolve() -> URL {
        let environment = ProcessInfo.processInfo.environment
        if let path = environment["WORKBENCH_DATA"], !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        let home = FileManager.default.homeDirectoryForCurrentUser
        let config = home.appendingPathComponent("Library/Application Support/yovoice/storage.json")
        if let data = try? Data(contentsOf: config),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let path = json["dataPath"] as? String, !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return home.appendingPathComponent(".yovoice", isDirectory: true)
    }
}
