import Foundation
import MainworthyClient
import TestSupport
import Testing
@testable import MainworthyScreens
actor ReplyBarrier {
 private var armed=true
 private var release:CheckedContinuation<Void,Never>?
 private var announced=false
 func pause() async {
  guard armed else{return};armed=false
  announced=true
  await withCheckedContinuation {release=$0}
 }
 func hasPaused()->Bool{announced}
 func resume(){release?.resume();release=nil}
}
final class DelayedQuestion:Transport {
 let inner=URLSessionTransport();let barrier=ReplyBarrier()
 func send(_ request:URLRequest) async throws ->(Data,HTTPURLResponse){
  let reply=try await inner.send(request)
  if request.url?.lastPathComponent=="get"{await barrier.pause()}
  return reply
 }
 func lines(_ request:URLRequest) async throws ->(AsyncThrowingStream<String,any Error>,HTTPURLResponse){try await inner.lines(request)}
}
@Suite("A question read by itself is not replaced by an older read of it") @MainActor
struct ReviewReadRace {
 @Test func delayedOldQuestion() async throws {
  for n in 0..<2 {
   let key=try await Live.project();let owner=Live.server();_=try await owner.signIn(Live.owner)
   let project=owner.project(key);let q=try #require(try await project.questions(open:true,kind:.failure).questions.first)
   let transport=DelayedQuestion();let server=Server(instance:Live.instance,secrets:MemoryStore(),transport:transport);_=try await server.signIn(Live.owner)
   let screen=QueueScreen(project:server.project(key));await screen.show(.open,filter:.map)
   let opening=Task {await screen.open(q.ref)}
   while !(await transport.barrier.hasPaused()){await Task.yield()}
   _=try await project.answer(q,with:try #require(q.choices.first {$0.answer=="infra"}))
   // Keep the opened question outside the current list, as a filter or another tab can.
   await screen.refresh()
   let newer=try #require(screen.current(q.ref))
   await transport.barrier.resume();await opening.value
   let late=try #require(screen.current(q.ref))
   let settled=await screen.answer(late,with:try #require(late.choices.first {$0.answer=="flaky"}))
   let actual=try #require(try await project.question(q.ref))
   print("OPEN_READ_RACE attempt=\(n) newerOpen=\(newer.isOpen) lateOpen=\(late.isOpen) lateDecision=\(late.decision?.label ?? "nil") returnedSettled=\(settled) notice=\(screen.notice?.text ?? "nil") actualDecision=\(actual.decision?.label ?? "nil")")
   // The older read does not bring back the open question, and a decided question is not answered over.
   #expect(!newer.isOpen && !late.isOpen && !settled && actual.decision?.label=="Infrastructure")
  }
 }
}
