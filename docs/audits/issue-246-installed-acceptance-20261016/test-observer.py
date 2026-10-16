"""Validate evidence rejection rules with fixtures; not OS reboot acceptance."""
import copy
import importlib.util
import json
import pathlib
import plistlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('observer', pathlib.Path(__file__).with_name('observe-next-boot.py'))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)
EPOCH = 1792130000
IDLE = {key: 0 for key in observer.WORK_KEYS}
IDLE['backgroundProcessState'] = 'confirmed'
READY = {'phase': 'running', 'runtimePID': 123, 'bridgeConnected': True,
         'tunnelConnected': True, 'readServiceStatus': 'ready', 'defaultRouteAvailable': True,
         'lifecycle': {'kind': 'start', 'phase': 'completed',
                       'updatedAt': '2026-10-16T05:54:50+00:00'},
         'startup': {'source': 'helper-launch', 'startedAt': EPOCH * 1000 + 1000,
                     'deadlineAt': EPOCH * 1000 + 301000, 'attempts': 1, 'stage': 'ready'}}


class EvidenceRules(unittest.TestCase):
    def test_ready_receipt(self):
        self.assertTrue(observer.automatic_ready(READY, EPOCH))

    def test_old_boot_or_manual_start_cannot_pass(self):
        self.assertFalse(observer.automatic_ready(READY, EPOCH + 200))
        manual = copy.deepcopy(READY)
        manual['startup']['source'] = None
        self.assertFalse(observer.automatic_ready(manual, EPOCH))

    def test_exceeded_budget_or_attempt_limit_cannot_pass(self):
        value = copy.deepcopy(READY)
        value['startup']['deadlineAt'] = value['startup']['startedAt'] + 300001
        self.assertFalse(observer.automatic_ready(value, EPOCH))
        value = copy.deepcopy(READY)
        value['startup']['attempts'] = 4
        self.assertFalse(observer.automatic_ready(value, EPOCH))

    def test_shortened_budget_cannot_pass_even_if_ready_before_its_deadline(self):
        value = copy.deepcopy(READY)
        value['startup']['deadlineAt'] = value['startup']['startedAt'] + 30000
        value['lifecycle']['updatedAt'] = '2026-10-16T05:53:41+00:00'
        self.assertFalse(observer.automatic_ready(value, EPOCH))

    def test_runtime_changes_without_updated_build_metadata_change_identity(self):
        with tempfile.TemporaryDirectory() as name:
            app = pathlib.Path(name)
            runtime = app / 'Contents/Resources/Runtime'
            binary = app / 'Contents/MacOS/CodexBridgeMenuBar'
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b'native executable')
            (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
                'CFBundleShortVersionString': '0.4.1', 'CFBundleVersion': '17'}))
            (runtime / 'dist').mkdir(parents=True)
            (runtime / 'dist/build-info.json').write_text(json.dumps({
                'id': 'unchanged', 'sourceHash': 'unchanged', 'commit': 'unchanged'}))
            for relative in ('dist/macosHelper.js', 'scripts/start-codex-mcp-bridge.mjs',
                             'node_modules/dependency/index.js'):
                target = runtime / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text('original implementation')
            with patch.object(observer, 'APP', app):
                original = observer.artifact()
                for relative in ('dist/macosHelper.js', 'scripts/start-codex-mcp-bridge.mjs',
                                 'node_modules/dependency/index.js'):
                    with self.subTest(relative=relative):
                        target = runtime / relative
                        target.write_text('replaced implementation')
                        self.assertNotEqual(observer.artifact(), original)
                        target.write_text('original implementation')
                extra = runtime / 'dist/extra.js'
                extra.write_text('new implementation')
                self.assertNotEqual(observer.artifact(), original)
                extra.unlink()
                (runtime / 'dist/macosHelper.js').unlink()
                self.assertNotEqual(observer.artifact(), original)

    def test_runtime_symlink_retargeting_changes_identity_and_external_links_are_rejected(self):
        with tempfile.TemporaryDirectory() as name:
            root = pathlib.Path(name)
            runtime = root / 'runtime'
            runtime.mkdir()
            for filename in ('first.js', 'second.js'):
                (runtime / filename).write_text(filename)
            link = runtime / 'command'
            link.symlink_to('first.js')
            original = observer.runtime_sha256(runtime)
            link.unlink()
            link.symlink_to('second.js')
            self.assertNotEqual(observer.runtime_sha256(runtime), original)
            link.unlink()
            (root / 'external.js').write_text('external code')
            link.symlink_to('../external.js')
            with self.assertRaises(ValueError):
                observer.runtime_sha256(runtime)
            link.unlink()
            link.symlink_to('.')
            with self.assertRaises(ValueError):
                observer.runtime_sha256(runtime)

    def test_unknown_or_protected_work_is_not_idle(self):
        self.assertTrue(observer.no_work(IDLE))
        for key in observer.WORK_KEYS:
            value = dict(IDLE)
            value[key] = 'unknown' if key == 'backgroundProcessState' else 1
            self.assertFalse(observer.no_work(value), key)
        self.assertFalse(observer.no_work({}))

    def test_same_boot_never_queries_product(self):
        with tempfile.TemporaryDirectory() as name:
            directory = pathlib.Path(name)
            observer.private_write(directory, 'manifest.json', {
                'kind': 'issue-246-installed-next-boot', 'boot': {'id': 'same'}})
            with patch.object(observer, 'boot', return_value={'id': 'same'}), \
                    patch.object(observer, 'rpc', side_effect=AssertionError('must not query')):
                observer.observe(directory)
            self.assertFalse((directory / 'result.json').exists())
            self.assertFalse(json.loads((directory / 'same-boot-rejected.json').read_text())['accepted'])

    def test_busy_prepare_does_not_arm(self):
        work = dict(IDLE, activeJobs=1)
        with tempfile.TemporaryDirectory() as name, patch.object(observer, 'rpc', return_value=work):
            with self.assertRaises(SystemExit):
                observer.prepare(pathlib.Path(name))
            self.assertFalse((pathlib.Path(name) / 'manifest.json').exists())

    def test_stale_preflight_or_replaced_artifact_cannot_pass(self):
        for stale, replaced in ((True, False), (False, True)):
            with self.subTest(stale=stale, replaced=replaced), tempfile.TemporaryDirectory() as name:
                directory = pathlib.Path(name)
                observer.private_write(directory, 'manifest.json', {
                    'kind': 'issue-246-installed-next-boot', 'boot': {'id': 'old'},
                    'preparedAt': '2026-10-16T04:52:50+00:00' if stale else '2026-10-16T05:52:50+00:00',
                    'artifact': {'test': True}, 'preflight': IDLE})
                with patch.object(observer, 'boot', return_value={'id': 'new', 'epoch': EPOCH}), \
                        patch.object(observer, 'artifact', return_value={'test': not replaced}), \
                        patch.object(observer, 'snapshot', side_effect=[{'defaultRouteAvailable': False}, READY]), \
                        patch.object(observer.time, 'sleep'):
                    observer.observe(directory)
                self.assertFalse(json.loads((directory / 'result.json').read_text())['technicalChecksPassed'])

    def test_network_delay_requires_an_actual_observed_transition(self):
        for delay in (False, True):
            with self.subTest(delay=delay), tempfile.TemporaryDirectory() as name:
                directory = pathlib.Path(name)
                observer.private_write(directory, 'manifest.json', {
                    'kind': 'issue-246-installed-next-boot', 'boot': {'id': 'old'},
                    'preparedAt': '2026-10-16T05:52:50+00:00', 'artifact': {'test': True}, 'preflight': IDLE})
                rows = ([{'defaultRouteAvailable': False}] if delay else []) + [READY]
                with patch.object(observer, 'boot', return_value={'id': 'new', 'epoch': EPOCH}), \
                        patch.object(observer, 'artifact', return_value={'test': True}), \
                        patch.object(observer, 'snapshot', side_effect=rows), \
                        patch.object(observer.time, 'sleep'):
                    observer.observe(directory)
                result = json.loads((directory / 'result.json').read_text())
                self.assertEqual(result['technicalChecksPassed'], delay)

    def test_artifact_change_during_observation_cannot_pass(self):
        with tempfile.TemporaryDirectory() as name:
            directory = pathlib.Path(name)
            observer.private_write(directory, 'manifest.json', {
                'kind': 'issue-246-installed-next-boot', 'boot': {'id': 'old'},
                'preparedAt': '2026-10-16T05:52:50+00:00',
                'artifact': {'test': True}, 'preflight': IDLE})
            with patch.object(observer, 'boot', return_value={'id': 'new', 'epoch': EPOCH}), \
                    patch.object(observer, 'artifact', side_effect=[{'test': True}, {'test': False}]), \
                    patch.object(observer, 'snapshot', side_effect=[{'defaultRouteAvailable': False}, READY]), \
                    patch.object(observer.time, 'sleep'):
                observer.observe(directory)
            result = json.loads((directory / 'result.json').read_text())
            self.assertTrue(result['automaticReadyWithinBudget'])
            self.assertFalse(result['artifactMatches'])
            self.assertFalse(result['technicalChecksPassed'])

    def test_prior_boot_terminal_records_do_not_end_observation(self):
        for phase in ('failed', 'cancelled'):
            for prior_start in (EPOCH * 1000 - 1000, None):
                with self.subTest(phase=phase, prior_start=prior_start), tempfile.TemporaryDirectory() as name:
                    directory = pathlib.Path(name)
                    observer.private_write(directory, 'manifest.json', {
                        'kind': 'issue-246-installed-next-boot', 'boot': {'id': 'old'},
                        'preparedAt': '2026-10-16T05:52:50+00:00',
                        'artifact': {'test': True}, 'preflight': IDLE})
                    previous = {'defaultRouteAvailable': False,
                                'lifecycle': {'kind': 'start', 'phase': phase},
                                'startup': {'startedAt': prior_start}}
                    with patch.object(observer, 'boot', return_value={'id': 'new', 'epoch': EPOCH}), \
                            patch.object(observer, 'artifact', return_value={'test': True}), \
                            patch.object(observer, 'snapshot', side_effect=[previous, READY]) as snapshots, \
                            patch.object(observer.time, 'sleep'):
                        observer.observe(directory)
                    self.assertEqual(snapshots.call_count, 2)
                    self.assertTrue(json.loads((directory / 'result.json').read_text())['technicalChecksPassed'])

    def test_current_boot_terminal_records_end_observation(self):
        for phase in ('failed', 'cancelled'):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as name:
                directory = pathlib.Path(name)
                observer.private_write(directory, 'manifest.json', {
                    'kind': 'issue-246-installed-next-boot', 'boot': {'id': 'old'},
                    'preparedAt': '2026-10-16T05:52:50+00:00',
                    'artifact': {'test': True}, 'preflight': IDLE})
                terminal = {'defaultRouteAvailable': False,
                            'lifecycle': {'kind': 'start', 'phase': phase},
                            'startup': {'startedAt': EPOCH * 1000 + 1000}}
                with patch.object(observer, 'boot', return_value={'id': 'new', 'epoch': EPOCH}), \
                        patch.object(observer, 'artifact', return_value={'test': True}), \
                        patch.object(observer, 'snapshot', return_value=terminal) as snapshots, \
                        patch.object(observer.time, 'sleep'):
                    observer.observe(directory)
                self.assertEqual(snapshots.call_count, 1)
                self.assertFalse(json.loads((directory / 'result.json').read_text())['technicalChecksPassed'])


if __name__ == '__main__':
    unittest.main()
