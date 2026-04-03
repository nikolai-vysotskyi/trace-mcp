export async function getStaticProps() {
  return { props: { title: 'About' } };
}

export default function About({ title }: { title: string }) {
  return <div>{title}</div>;
}
