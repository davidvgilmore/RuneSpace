from pathlib import Path
import sys
import unittest
from unittest.mock import patch

PLAY = Path(__file__).resolve().parents[1] / 'layout/mods/runespace/play'
with patch.object(sys, 'path', [str(PLAY), *sys.path]), patch.object(sys, 'argv', ['presenter', '.']):
    from presenter import RenderSize


class RenderSizeTests(unittest.TestCase):
    def setUp(self):
        self.quality = RenderSize()

    def test_retina_pane_without_pixel_report_preserves_its_measured_aspect(self):
        # 152 x 38 painted cells inside a 2624 x 1644 window.
        self.assertEqual(self.quality.dimensions(40, 152, 0, 0, None), (1536, 836))

    def test_positive_pixel_report_overrides_cell_hints_and_limits_upscaling(self):
        self.assertEqual(self.quality.dimensions(50, 100, 960, 750, (17,37)), (960,720))

    def test_reported_cell_aspect_and_logical_retina_units(self):
        self.assertEqual(self.quality.dimensions(40, 152, 0, 0, (8,18)), (1536,864))
        self.assertEqual(self.quality.dimensions(40, 152, 0, 0, (16,36)), (1536,864))

    def test_portrait_pane_scales_both_axes_when_reaching_the_height_cap(self):
        w, h = self.quality.dimensions(100, 40, 800, 2400, None)
        self.assertLessEqual(h, self.quality.MAX_HEIGHT)
        self.assertAlmostEqual(h/w, 2352/800, delta=.005)

    def test_quality_drops_only_after_sustained_pressure_and_recovers_gradually(self):
        for i in range(65):
            self.quality.observe(i*.02, i*.02+.018, 1536)
        self.assertEqual(self.quality.limit, 1536)
        for i in range(65,102):
            self.quality.observe(i*.02, i*.02+.018, 1536)
        reduced=self.quality.limit
        self.assertLess(reduced,1536)
        for i in range(200):
            t=2.04+i/60
            self.quality.observe(t,t+.007,reduced)
        self.assertEqual(self.quality.limit,reduced)
        for i in range(200,650):
            t=2.04+i/60
            self.quality.observe(t,t+.007,self.quality.limit)
        self.assertEqual(self.quality.limit,reduced+128)


if __name__ == '__main__':
    unittest.main()
