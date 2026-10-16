#!/usr/bin/env python3
"""Build an isolated app fixture; run the printed executable and click Reload list.

Does not install/replace the operational app. Requires macOS/Xcode. The requested
output directory must not exist. Only synthetic data and fixture sockets are used.
"""
import json
import pathlib
import plistlib
import shutil
import subprocess
import sys

repo = pathlib.Path(__file__).resolve().parents[3]
root = pathlib.Path(sys.argv[1]).resolve()
root.mkdir(mode=0o700)
source = root / 'macos'
source.mkdir()
shutil.copytree(repo / 'macos/Sources', source / 'Sources')
shutil.copy(repo / 'macos/Package.swift', source)
(source / 'Tests/CodexBridgeKitTests').mkdir(parents=True)
(source / 'Tests/CodexBridgeKitTests/Placeholder.swift').write_text('import XCTest\n')
main = source / 'Sources/CodexBridgeMenuBar/CodexBridgeMenuBarApp.swift'
text = main.read_text()
assert text.count('@main\nstruct CodexBridgeMenuBarApp') == 1
main.write_text(text.replace('@main\nstruct CodexBridgeMenuBarApp', 'struct CodexBridgeMenuBarApp'))
shutil.copy(pathlib.Path(__file__).with_name('NativeUIProbe.swift'), main.parent)
shutil.copy(repo / 'macos/Tests/CodexBridgeKitTests/NativeRPCFixture.swift', main.parent)
page = dict(offset=0, limit=12, returned=0, total=0, returnedConversations=0, conversationTotal=0, hasPrevious=False, hasNext=False)
counts = dict.fromkeys('trackedProjects trackedConversations retainedJobs active running inputRequired approvalRequired terminating needsAttention backgroundProcesses backgroundProcessAgents runtimeUnknownAgents runtimeProbeSkippedAgents completed failed interrupted cancelled idleAgents orphanedAgents'.split(), 0)
snapshot = dict(kind='dashboard', generatedAt='2026-10-16T00:00:00.000Z', scope='synthetic-ui-fixture', statusSource='codex-runtime-only', coverage='complete', counts=counts, activeRows=[], terminalRows=[], idleRows=[], pagination=dict(active=page, terminal=page, idle=page), uiLocalePreference='en')
health = dict(kind='helper-status', generatedAt=snapshot['generatedAt'], phase='running', pid=42, startedAt=None, lastExit=None, lastError=None, restartAttempt=0,
              configuration=dict(path='/fixture/.env', exists=True, valid=True, hasApiKey=True, hasTunnelId=True, tunnelId='fixture', issue=None),
              bridge=dict(socketPath='/fixture/bridge.sock', connected=True, acceptingNewJobs=True, activeJobs=0, pendingAdmissions=0, backgroundProcessState='confirmed', backgroundProcesses=0, backgroundProcessAgents=0, backgroundProcessUnknownAgents=0),
              tunnel=dict(phase='connected', profile='managed', transport='stdio', doctorPassed=True, processRunning=True, connected=True, lastCheckedAt=None, lastError=None))
for name, data in [('helper', health), ('dashboard', snapshot)]:
    (root / (name+'.json')).write_text(json.dumps(data))
subprocess.run(['swift', 'build', '--package-path', str(source), '--product', 'CodexBridgeMenuBar', '-Xswiftc', '-strict-concurrency=complete', '-Xswiftc', '-warnings-as-errors'], check=True)
binary_dir = pathlib.Path(subprocess.check_output(['swift', 'build', '--package-path', str(source), '--show-bin-path'], text=True).strip())
app = root / 'Bridge Issue264 UI Probe.app'
(app / 'Contents/MacOS').mkdir(parents=True)
(app / 'Contents/Resources').mkdir()
exe = app / 'Contents/MacOS/BridgeIssue264UIProbe'
shutil.copy(binary_dir / 'CodexBridgeMenuBar', exe)
with (app / 'Contents/Info.plist').open('wb') as f:
    plistlib.dump(dict(CFBundleIdentifier='com.menaje.bridge-issue264-ui-probe', CFBundleName='Bridge Issue264 UI Probe', CFBundleExecutable=exe.name, CFBundleVersion='1', CFBundleShortVersionString='1.0', CFBundlePackageType='APPL', LSMinimumSystemVersion='13.0', NSHighResolutionCapable=True, AcceptanceRoot=str(root)), f)
subprocess.run(['xcrun', 'xcstringstool', 'compile', str(repo / 'macos/Resources/Localization/Localizable.xcstrings'), '--output-directory', str(app / 'Contents/Resources'), '--serialization-format', 'text'], check=True)
subprocess.run(['codesign', '--force', '--sign', '-', str(app)], check=True)
print(exe)
