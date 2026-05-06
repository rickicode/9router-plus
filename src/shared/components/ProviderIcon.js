"use client";

import { useState } from "react";
import Image from "next/image";
import PropTypes from "prop-types";

export default function ProviderIcon({
  src,
  alt,
  size = 32,
  className = "",
  fallbackText = "?",
  fallbackColor,
}) {
  const [errored, setErrored] = useState(false);
  const [actualSrc, setActualSrc] = useState(src);

  function handleError() {
    if (src?.endsWith(".png") && !actualSrc?.endsWith(".svg")) {
      setActualSrc(src.replace(/\.png$/, ".svg"));
    } else {
      setErrored(true);
    }
  }

  if (!actualSrc || errored) {
    return (
      <span
        className={`inline-flex items-center justify-center font-bold rounded-lg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: fallbackColor,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {fallbackText}
      </span>
    );
  }

  return (
    <Image
      src={actualSrc}
      alt={alt || ""}
      width={size}
      height={size}
      className={className}
      onError={handleError}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
};
