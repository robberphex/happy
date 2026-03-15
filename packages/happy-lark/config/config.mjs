import 'dotenv/config';

console.log(process.env.DATABASE_URL);
export default {
  development: {
    use_env_variable: 'DATABASE_URL',
  },
};
