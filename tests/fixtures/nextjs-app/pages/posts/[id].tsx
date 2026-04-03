export async function getServerSideProps(context: any) {
  return { props: { id: context.params.id } };
}

export async function getStaticPaths() {
  return { paths: [], fallback: false };
}

export default function Post({ id }: { id: string }) {
  return <div>Post {id}</div>;
}
