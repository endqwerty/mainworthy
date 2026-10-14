import Foundation
import MainworthyClient
import TestSupport
import Testing
@testable import MainworthyScreens

final class IncompletePart: Transport {
 let inner = URLSessionTransport()
 let field: String
 let section: String
 init(_ field:String, section:String="body") {self.field=field;self.section=section}
 func send(_ request:URLRequest) async throws -> (Data,HTTPURLResponse) {
  let (data,response)=try await inner.send(request)
  guard request.url?.lastPathComponent=="get" else{return (data,response)}
  var envelope=try JSONDecoder().decode(JSONValue.self,from:data).object!
  envelope["result"] = .array((envelope["result"]?.array ?? []).map { row in
   var row=row.object!
   if let edits=row["edits"]?.array {row["edits"] = .array(edits.map { part in
    var part=part.object!
    if section=="placement" {
     if field=="badTags" {part["tags"] = [77]} else {part.removeValue(forKey:field)}
    } else if var body=part[section]?.object {
     if field.hasPrefix("step.") {
      body["steps"] = .array((body["steps"]?.array ?? []).map { step in var step=step.object!;step.removeValue(forKey:String(field.dropFirst(5)));return .object(step)})
     } else {body.removeValue(forKey:field)}
     part[section] = .object(body)
    }
    return .object(part)
   })}
   return .object(row)
  })
  return (try JSONEncoder().encode(JSONValue.object(envelope)),response)
 }
 func lines(_ request:URLRequest) async throws -> (AsyncThrowingStream<String,any Error>,HTTPURLResponse){try await inner.lines(request)}
}
@Suite("A document that lacks a part, or holds a part of another type, is not shown") @MainActor
struct ReviewFifth {
 @Test func everyPart() async throws {
  for attempt in 0..<2 {
   for (section,fields) in [("body",["fields","steps","methods","automate","pre","title"]),("current",["fields","steps","methods","automate","pre","title"]),("placement",["folder","tags","covers","badTags"])] {
    for field in fields {
     let key=try await Live.project(strict:true)
     let owner=Live.server();_=try await owner.signIn(Live.owner)
     let title="Completeness \(section) \(field)"
     let edit:JSONValue=section=="current"
       ? ["op":"edit","case":"C-1","base":1,"body":["title":.string(title),"fields":["risk":"high"]]]
       : ["op":"create","folder":"Review/Folder","tags":["hidden-tag"],"covers":["REQ-1"],"body":["title":.string(title),"pre":"Signed in","methods":["human","auto"],"automate":"wanted","fields":["risk":"high"],"steps":[["id":"probe","action":"Do it","expected":"Works"]]]]
     let made:JSONValue=try await owner.write("propose",in:key,["reason":"Review fixture","edits":[edit]])
     let server=Server(instance:Live.instance,secrets:MemoryStore(),transport:IncompletePart(field,section:section));_=try await server.signIn(Live.owner)
     let screen=QueueScreen(project:server.project(key));await screen.show(.open,filter:nil)
     let q=try #require(screen.questions.first {$0.ref==made["question"]?.string});await screen.readDocuments(of:q)
     let wasShown=screen.isShown(q)
     var shownTags:[String]?=nil
     if case .read(let docs)=screen.documents(of:q){shownTags=docs.first?.placement?.tags}
     let accepted=await screen.answer(q,with:try #require(q.choices.first {$0.answer=="accept"}),reason:"Read all visible content")
     let live=try #require(try await owner.project(key).question(q.ref))
     var storedTags:[String]=[]
     if accepted && section=="placement" {
      let found:JSONValue=try await owner.read("find",in:key,["in":"cases","text":.string(title)])
      if let ref=found["items"]?.array?.first?["ref"]?.string {
       let rows:[JSONValue]=try await owner.read("get",in:key,["refs":[.string(ref)]])
       storedTags=rows.first?["tags"]?.array?.compactMap(\.string) ?? []
      }
     }
     print("COMPLETENESS attempt=\(attempt) section=\(section) field=\(field) shown=\(wasShown) accepted=\(accepted) open=\(live.isOpen) shownTags=\(String(describing:shownTags)) storedTags=\(storedTags)")
     #expect(!wasShown && !accepted && live.isOpen)
    }
   }
  }
 }
 @Test func stepParts() async throws {
  for n in 0..<2 {
   for field in ["step.id","step.action","step.expected"] {
    let key=try await Live.project(strict:true);let owner=Live.server();_=try await owner.signIn(Live.owner)
    let made:JSONValue=try await owner.write("propose",in:key,["reason":"Review fixture","edits":[["op":"create","body":["title":"Step completeness","steps":[["id":"probe","action":"Do it","expected":"Hidden expected result"]]]]]])
    let server=Server(instance:Live.instance,secrets:MemoryStore(),transport:IncompletePart(field));_=try await server.signIn(Live.owner)
    let screen=QueueScreen(project:server.project(key));await screen.show(.open,filter:nil)
    let q=try #require(screen.questions.first {$0.ref==made["question"]?.string});await screen.readDocuments(of:q)
    let shown=screen.isShown(q);var expected:String?=nil
    if case .read(let docs)=screen.documents(of:q){expected=docs.first?.after.steps.first?.expected}
    let accepted=await screen.answer(q,with:try #require(q.choices.first {$0.answer=="accept"}),reason:"Reviewed visible content")
    var storedExpected=false
    if accepted {
     let found:JSONValue=try await owner.read("find",in:key,["in":"cases","text":"Step completeness"])
     let ref=try #require(found["items"]?.array?.first?["ref"]?.string)
     let rows:[JSONValue]=try await owner.read("get",in:key,["refs":[.string(ref)],"as":"md"])
     storedExpected=rows.first?["md"]?.string?.contains("Hidden expected result")==true
    }
    print("STEP_PART attempt=\(n) field=\(field) shown=\(shown) expected=\(String(describing:expected)) accepted=\(accepted) storedHiddenExpected=\(storedExpected)")
    #expect(!shown && !accepted)
   }
  }
 }
 @Test func longProposal() async throws {
  for n in 0..<2 {
   let key=try await Live.project(strict:true);let owner=Live.server();_=try await owner.signIn(Live.owner)
   let edits:[JSONValue]=(0..<21).map {i in ["op":"create","outline":.string("Long case \(i)")]}
   let made:JSONValue=try await owner.write("propose",in:key,["reason":"Review fixture","edits":.array(edits)])
   let screen=QueueScreen(project:owner.project(key));await screen.show(.open,filter:nil)
   let q=try #require(screen.questions.first {$0.ref==made["question"]?.string});await screen.readDocuments(of:q)
   guard case .proposal(let edit)=q.evidence else {Issue.record("not proposal");return}
   print("LONG attempt=\(n) count=\(edit.count) summaries=\(edit.summaries.count) reason=\(String(describing:edit.notShown)) shown=\(screen.isShown(q)) choices=\(q.choices.map(\.takes))")
   #expect(edit.notShown == .tooManyEdits && !screen.isShown(q) && q.choices.allSatisfy {$0.takes == .more})
  }
 }
 @Test func standaloneState() async throws {
  for n in 0..<2 {
   let key=try await Live.project();let owner=Live.server();_=try await owner.signIn(Live.owner)
   let screen=QueueScreen(project:owner.project(key));await screen.show(.open,filter:nil)
   let original=try #require(screen.questions.first {$0.kind == .failure});await screen.open(original.ref)
   await screen.show(.decided,filter:nil);let open=try #require(screen.current(original.ref))
   #expect(open.isOpen && open.standing == .counts)
   let other=try await Live.signedIn().project(key);_=try await other.answer(open,with:try #require(open.choices.first {$0.answer=="infra"}))
   await screen.refresh();let decided=try #require(screen.current(original.ref))
   print("STANDALONE attempt=\(n) showing=\(screen.showing) originallyOpen=\(open.isOpen) afterOtherAnswerOpen=\(decided.isOpen) decision=\(decided.decision?.label ?? "nil")")
   #expect(!decided.isOpen && decided.decision?.label=="Infrastructure")
   await screen.show(.open,filter:nil);#expect(screen.current(original.ref)?.decision != nil)
   screen.close(original.ref);#expect(screen.current(original.ref)==nil)
  }
 }
}
