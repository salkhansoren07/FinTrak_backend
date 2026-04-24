export async function getGoogleUser(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!res.ok) {
    return null;
  }

  const user = await res.json();
  if (!user?.sub) {
    return null;
  }

  return user;
}

export async function getGmailUser(accessToken) {
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });

  if (!res.ok) {
    return null;
  }

  const profile = await res.json();
  if (!profile?.emailAddress) {
    return null;
  }

  return {
    sub: profile.emailAddress.toLowerCase(),
    email: profile.emailAddress.toLowerCase(),
  };
}

export async function getUserFromAccessToken(accessToken) {
  if (!accessToken) {
    return null;
  }

  const googleUser = await getGoogleUser(accessToken);
  if (googleUser) {
    return googleUser;
  }

  return getGmailUser(accessToken);
}
