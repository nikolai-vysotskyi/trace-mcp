import { Router } from 'express';

const router = Router();

router.get('/', (req, res) => {
  res.json([]);
});

router.get('/:id', (req, res) => {
  res.json({ id: req.params.id });
});

router.post('/', (req, res) => {
  res.json(req.body);
});

export const userRouter = router;
