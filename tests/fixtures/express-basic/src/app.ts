import express from 'express';
import cors from 'cors';
import { userRouter } from './routes/users';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/users', userRouter);

app.listen(3000);
