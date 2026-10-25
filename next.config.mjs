const nextConfig = {
  async redirects() {
    return [
      {
        source: "/slides",
        destination: "/slides/index.html",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
