FROM nginx:alpine

# Remove default config
RUN rm /etc/nginx/conf.d/default.conf

# Add custom config (will be mounted via volume)
COPY nginx.*.conf /etc/nginx/

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
