# Bounded #222 pull trial

Sites hosting enforces the existing owner-only audience. These endpoints accept
only the existing supported service authentication for this fixed non-user
fixture; no visitor identity or connected-app consent is inferred.

- POST /roundtrip/enqueue with {}: backend creates exactly one fixed read_fixture
  command, derived from the existing D1 fixture. Repetition retains one command.
- POST /roundtrip/claim with {}: atomically claims the queued command once.
- POST /roundtrip/ack with {response: <fixed local response>}: stores only the
  exact expected fixture response. Repetition preserves its first ack timestamp.
- GET /roundtrip/status: reads the saved command, response, digests and timestamps.

There is no push, tunnel binding, polling loop, background process, schedule,
arbitrary command, URL, shell, path, scope reference, or credential creation.
read_fixture remains read-only and never creates/claims/acks a command.
Its additional roundtrip object uses SELECT only and returns non-sensitive saved
receipt state/digests. executionCount is the validated local-handler ACK report;
the independent loopback log is separate evidence of actual execution.
The one-shot local process is separately owned and closed by the test runner.
The original fixture table and its existing migration are untouched.
