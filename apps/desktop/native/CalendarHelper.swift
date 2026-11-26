import Foundation
import EventKit
import CryptoKit

let store = EKEventStore()
func emit(_ value: [String: Any]) { let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); print(String(data: data, encoding: .utf8)!) }
func permission() -> String {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(macOS 14.0, *) { if status == .fullAccess { return "granted" } }
    else if status == .authorized { return "granted" }
    return status == .notDetermined ? "not_determined" : status == .restricted ? "restricted" : "denied"
}
func calendarRows() -> [[String: String]] { return store.calendars(for: .event).filter { $0.allowsContentModifications }.map { ["id": $0.calendarIdentifier, "name": $0.title] } }
func version(_ event: EKEvent) -> String {
    let value = [event.title ?? "",event.notes ?? "",String(event.startDate.timeIntervalSince1970),String(event.endDate.timeIntervalSince1970),String(event.alarms?.first?.relativeOffset ?? 0)].joined(separator: "\u{0}")
    return SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}
func parseDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter();formatter.formatOptions = [.withInternetDateTime,.withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime];return formatter.date(from: value)
}
func execute(_ input: [String: Any]) throws -> [String: Any] {
    let action = input["action"] as? String ?? ""
    if action == "permission" {
        let complete = DispatchSemaphore(value:0)
        if #available(macOS 14.0, *) { store.requestFullAccessToEvents { _,_ in complete.signal() } }
        else { store.requestAccess(to: .event) { _,_ in complete.signal() } }
        let deadline = Date().addingTimeInterval(110)
        while Date() < deadline {
            if complete.wait(timeout:.now()+0.05) == .success { break }
            RunLoop.current.run(until:Date().addingTimeInterval(0.01))
        }
        return ["permission":permission(),"calendars":permission() == "granted" ? calendarRows() : []]
    }
    if action == "status" || action == "calendars" { return ["permission":permission(),"calendars":permission() == "granted" ? calendarRows() : []] }
    guard permission() == "granted" else { return ["status":"failed","error_code":"permission_required"] }
    guard let calendarId = input["calendar_id"] as? String, let calendar = store.calendar(withIdentifier: calendarId),calendar.allowsContentModifications else { return ["status":"failed","error_code":"calendar_unavailable"] }
    guard let item = input["item"] as? [String: Any],let draft = item["draft"] as? [String: Any] else { return ["status":"failed","error_code":"invalid_request"] }
    let systemId = item["system_id"] as? String ?? ""
    if action == "query_created",let raw = draft["starts_at"] as? String,let start = parseDate(raw),let itemId = item["id"] as? String {
        let marker = "workstep://calendar/item/" + itemId
        let predicate = store.predicateForEvents(withStart:start.addingTimeInterval(-86400),end:start.addingTimeInterval(86400),calendars:[calendar])
        let found = store.events(matching:predicate).filter { $0.url?.absoluteString == marker }
        if found.count == 1,found[0].notes == draft["content"] as? String,let alarm = found[0].alarms?.first,
           abs(alarm.relativeOffset + Double(draft["reminder_minutes"] as? Int ?? 0)*60) < 1 {
            return ["status":"succeeded","verification":"present","system_id":found[0].eventIdentifier!,"system_revision":version(found[0])]
        }
        return ["status":"unknown","error_code":"verification_unknown"]
    }
    let existing = systemId.isEmpty ? nil : store.event(withIdentifier: systemId)
    if let current = existing {
        guard current.calendar.calendarIdentifier == calendarId, !current.hasRecurrenceRules else { return ["status":"failed","error_code":"conflict"] }
        if action != "query",let expected = item["system_revision"] as? String,expected != version(current) { return ["status":"failed","error_code":"conflict"] }
    }
    if action == "query" {
        guard let current = existing else { return ["status":"succeeded","verification":"absent","system_id":systemId] }
        let formatter = ISO8601DateFormatter()
        return ["status":"succeeded","verification":"present","system_id":systemId,"system_revision":version(current),
                "event":["content":current.notes?.isEmpty == false ? current.notes! : current.title ?? "WorkStep",
                         "starts_at":formatter.string(from:current.startDate),"timezone_name":current.timeZone?.identifier ?? "UTC",
                         "reminder_minutes":max(0,Int(-(current.alarms?.first?.relativeOffset ?? 0)/60))]]
    }
    if action == "delete" {
        if let current = existing { try store.remove(current,span:.thisEvent,commit:true);store.reset() }
        return ["status":store.event(withIdentifier:systemId) == nil ? "succeeded" : "unknown","verification":"absent","system_id":systemId]
    }
    guard action == "create" || action == "update",let content = draft["content"] as? String,content.count <= 20000,!content.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty,
          let rawDate = draft["starts_at"] as? String,let start = parseDate(rawDate),let zoneName = draft["timezone_name"] as? String,let zone = TimeZone(identifier:zoneName) else { return ["status":"failed","error_code":"invalid_request"] }
    if action == "update" && existing == nil { return ["status":"failed","error_code":"conflict"] }
    let duration = item["duration_minutes"] as? Int ?? 30
    let minutes = draft["reminder_minutes"] as? Int ?? 0
    guard (1...10080).contains(duration),(0...10080).contains(minutes) else { return ["status":"failed","error_code":"invalid_request"] }
    let event = existing ?? EKEvent(eventStore:store)
    event.calendar = calendar;event.title = String((content.split(separator:"\n").first.map(String.init) ?? "WorkStep").replacingOccurrences(of:"[#*`_>]",with:"",options:.regularExpression).prefix(80));event.notes = content
    if action == "create",let id = item["id"] as? String { event.url = URL(string:"workstep://calendar/item/" + id) }
    event.startDate = start;event.endDate = start.addingTimeInterval(Double(duration)*60);event.timeZone = zone
    event.alarms = [EKAlarm(relativeOffset: -Double(minutes)*60)]
    try store.save(event,span:.thisEvent,commit:true)
    let id = event.eventIdentifier!;store.reset()
    guard let checked = store.event(withIdentifier:id),checked.notes == content,abs(checked.startDate.timeIntervalSince(start)) < 1,
          let alarm = checked.alarms?.first,abs(alarm.relativeOffset + Double(draft["reminder_minutes"] as? Int ?? 0)*60) < 1 else { return ["status":"unknown","error_code":"verification_unknown"] }
    return ["status":"succeeded","verification":"present","system_id":id,"system_revision":version(checked)]
}
do {
    guard let line = readLine(),line.utf8.count <= 240000,let data = line.data(using:.utf8),let input = try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw NSError(domain:"Calendar",code:1) }
    emit(try execute(input))
} catch { emit(["status":"unknown","error_code":"provider_error"]) }
