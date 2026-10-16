"""Validate evidence rejection rules with fixtures; not OS reboot acceptance."""
import copy
import importlib.util
import json
import pathlib
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


if __name__ == '__main__':
    unittest.main()
